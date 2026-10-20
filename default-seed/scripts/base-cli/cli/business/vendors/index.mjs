import { VendorExportError, fail, hash, client, object, assertCount, shape, stable } from './common.mjs';
import * as sentry from './sentry.mjs';
import * as uptimerobot from './uptimerobot.mjs';
import * as pagerduty from './pagerduty.mjs';
import * as calendly from './calendly.mjs';
import * as sorry from './sorry.mjs';

export { VendorExportError } from './common.mjs';
export const VENDORS = Object.freeze(['sentry','uptimerobot','pagerduty','calendly','sorry']);
const adapters = { sentry, uptimerobot, pagerduty, calendly, sorry };
export const VENDOR_CAPABILITIES = Object.freeze({
  sentry: Object.freeze({ vendor: 'sentry', adapter: 'rer:sentry', capability: 'vendor_key:sentry', format: 'spool-sentry-org-export-v1', layout: 'concatenate', output: 'sentry-export.json', readOnly: true, resume: true, scopes: ['org:read','project:read','event:read'], origins: Object.values(sentry.origins) }),
  uptimerobot: Object.freeze({ vendor: 'uptimerobot', adapter: 'rer:uptimerobot', capability: 'vendor_key:uptimerobot', format: 'uptimerobot-v3-monitors', layout: 'concatenate', output: 'uptimerobot-monitors.json', readOnly: true, resume: true, scopes: ['read-only API key'], origins: [uptimerobot.origin] }),
  pagerduty: Object.freeze({ vendor: 'pagerduty', adapter: 'rer:pagerduty', capability: 'vendor_key:pagerduty', format: 'pagerduty-saved-responses', layout: 'concatenate', output: 'pagerduty-export.json', readOnly: true, resume: true, scopes: ['read-only REST API key'], origins: [pagerduty.origin] }),
  calendly: Object.freeze({ vendor: 'calendly', adapter: 'rer:calendly', capability: 'vendor_key:calendly', format: 'dial-calendly-api-folder-v1', layout: 'files', output: 'manifest.json', readOnly: true, resume: true, scopes: ['personal access token with read access'], origins: [calendly.origin] }),
  // A public status page: read anonymously from the page's own address, so it takes no key.
  sorry: Object.freeze({ vendor: 'sorry', adapter: 'rer:sorry', capability: null, format: 'lamp-sorry-public-responses', layout: 'concatenate', output: 'sorry-export.json', readOnly: true, resume: true, scopes: [], origins: ['https://<page host>'] }),
});
/** The vendors whose export needs the owner's read-only key. */
export const KEYED_VENDORS = Object.freeze(VENDORS.filter(vendor => VENDOR_CAPABILITIES[vendor].capability !== null));
const LIMITS = Object.freeze({
  // Spool's 500-record bound also counts its synthesized manifest record.
  sentry: { bytes: 2 * 1024 * 1024, records: 499 },
  uptimerobot: { bytes: 8 * 1024 * 1024, records: 2500 },
  pagerduty: { bytes: 512 * 1024, records: 500 },
  calendly: { bytes: 8 * 1024 * 1024, records: 2500 },
  // Lamp's Sorry reader: 8 MiB of responses in at most 200 files and 5,000
  // records; its door takes twice that, as the bundle carries each response as
  // JSON text. Lamp reads a public page at most every 125 ms.
  sorry: { bytes: 8 * 1024 * 1024, emitted: 16 * 1024 * 1024, records: 5000, requests: 200, spacing: 125 },
});

/** Persist each checkpoint only after the corresponding bytes have been acknowledged.
 * Bytes are private seed-bound artifacts; checkpoints are metadata, never API bodies.
 */
export async function* exportVendor(vendor, { key, inputs = {}, checkpoint, signal } = {}) {
  try {
    if (!VENDORS.includes(vendor)) fail('UNSUPPORTED_VENDOR');
    const keyed = KEYED_VENDORS.includes(vendor);
    if (keyed ? typeof key !== 'string' || !key || key.length > 8192 || /[\u0000-\u0020\u007f]/u.test(key) : key != null) fail('INVALID_KEY');
    object(inputs);
    const fingerprint = hash(JSON.stringify(stable({ vendor, inputs })));
    const limits = { requests: 1000, ...LIMITS[vendor], pageBytes: 1024 * 1024 - 16 * 1024 };
    let state, sequence = 0;
    let counters = { requests: 0, received: 0, emitted: 0, records: 0 };
    if (checkpoint != null) {
      const encoded = JSON.stringify(checkpoint);
      if (Buffer.byteLength(encoded) >= 128 * 1024 || key && encoded.includes(key)) fail('INVALID_CHECKPOINT');
      const cp = JSON.parse(encoded);
      shape(cp, ['version','vendor','fingerprint','sequence','counters','state']);
      if (cp.version !== 1 || cp.vendor !== vendor || cp.fingerprint !== fingerprint) fail('INVALID_CHECKPOINT');
      sequence = assertCount(cp.sequence, 2000);
      shape(cp.counters, ['requests','received','emitted','records']); object(cp.state);
      counters = Object.fromEntries(Object.keys(counters).map(name => [name, assertCount(cp.counters[name], name === 'requests' ? limits.requests : name === 'records' ? limits.records : name === 'emitted' ? limits.emitted ?? limits.bytes : limits.bytes)]));
      state = cp.state;
    }
    const adapter = adapters[vendor];
    const origin = vendor === 'sentry' ? adapter.origins[inputs.organization?.region] : vendor === 'sorry' ? adapter.originOf(inputs) : adapter.origin;
    if (!origin) fail('INVALID_INPUT');
    const headers = { Accept: vendor === 'pagerduty' ? 'application/vnd.pagerduty+json;version=2' : 'application/json',
      ...(keyed ? { Authorization: vendor === 'pagerduty' ? `Token token=${key}` : `Bearer ${key}` } : {}) };
    const ctx = {
      inputs, state,
      get: client({ origin, headers, route: adapter.route, signal, limits, counters, key }),
      records(count) {
        counters.records += count;
        if (counters.records > limits.records) fail('RECORD_LIMIT');
      },
      item(value, nextState, name) {
        signal?.throwIfAborted();
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (bytes.length > 1024 * 1024 || (counters.emitted += bytes.length) > (limits.emitted ?? limits.bytes)) fail('BYTE_LIMIT');
        if (key && bytes.includes(Buffer.from(key))) fail('CREDENTIAL_IN_RESPONSE');
        if (++sequence > 2000) fail('ITEM_LIMIT');
        const cp = { version: 1, vendor, fingerprint, sequence, counters: { ...counters }, state: nextState };
        const encoded = JSON.stringify(cp);
        if (Buffer.byteLength(encoded) >= 128 * 1024 || key && encoded.includes(key)) fail('CHECKPOINT_LIMIT');
        return { name: name ?? `${String(sequence).padStart(6,'0')}.part`, bytes, checkpoint: JSON.parse(encoded) };
      },
    };
    yield* adapter.run(ctx);
  } catch (error) {
    if (error instanceof VendorExportError) throw error;
    throw new VendorExportError(signal?.aborted ? 'CANCELLED' : 'INVALID_EXPORT');
  }
}
