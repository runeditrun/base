import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../../default-seed/node_modules/esbuild/lib/main.js';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  canonicalReceiptJson, createReceiptEvidencePort, signImporterVerificationReceipt,
  validateImporters, verifyImporterVerificationReceipt,
} from '../src/index.ts';
import { documentedFixture, digest, verifiedFixture } from './status/fixtures.ts';

async function fixture() {
  const existing = verifiedFixture();
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const policy = {
    environment: 'stage',
    keys: {
      stage: { publicKey: keys.publicKey, environments: ['stage'] },
      other: { publicKey: other.publicKey, environments: ['stage'] },
    },
  };
  const receipt = await signImporterVerificationReceipt(existing.payload, 'stage', keys.privateKey);
  return { ...existing, keys, policy, receipt };
}

test('public signer and verifier round trip canonical JSON independently of insertion order and host collation', async () => {
  const { receipt, policy, payload, keys } = await fixture();
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const signedAgain = await signImporterVerificationReceipt(reordered, 'stage', keys.privateKey);
  assert.equal(signedAgain.signature, receipt.signature);
  assert.equal((await verifyImporterVerificationReceipt(receipt, policy)).valid, true);
  assert.equal((await verifyImporterVerificationReceipt({ ...receipt, payload: reordered }, policy)).valid, true);
  const numericKeys = { '2': { z: 1, a: 2 }, '10': ['b', 'a'] };
  assert.equal(canonicalReceiptJson(numericKeys).indexOf('"10"') < canonicalReceiptJson(numericKeys).indexOf('"2"'), true);
  for (const lossy of [undefined, NaN, { field: undefined }, new Date(), [ , 1]]) {
    assert.throws(() => canonicalReceiptJson(lossy));
  }
  // Unmapped items keep code-unit order under any host collation; Danish sorts "aa" after "z".
  const items = [
    { sourceIdentitySha256: 'aa' + '1'.repeat(62), sourceKind: 'ticket', fields: ['tags'] },
    { sourceIdentitySha256: 'b2' + '2'.repeat(62), sourceKind: 'ticket', fields: ['priority'] },
  ];
  const identities = items.map((item) => item.sourceIdentitySha256);
  assert.deepEqual([...identities].sort(), identities);
  const withUnmapped = (ordered) => {
    const unmapped = structuredClone(payload);
    for (const run of [unmapped.runs.dryRun, unmapped.runs.apply]) run.unmapped = ordered.length;
    unmapped.unmapped = { count: ordered.length, itemManifestSha256: digest(canonicalReceiptJson(ordered)), items: ordered };
    return signImporterVerificationReceipt(unmapped, 'stage', keys.privateKey);
  };
  const hostCompare = String.prototype.localeCompare;
  const danish = new Intl.Collator('da');
  String.prototype.localeCompare = function (that) { return danish.compare(String(this), String(that)); };
  try {
    assert.deepEqual([...identities].sort((left, right) => left.localeCompare(right)), [...identities].reverse());
    assert.equal((await verifyImporterVerificationReceipt(await withUnmapped(items), policy)).valid, true);
    assert.equal((await verifyImporterVerificationReceipt(await withUnmapped([...items].reverse()), policy)).valid, false);
  } finally {
    String.prototype.localeCompare = hostCompare;
  }
});

test('verification refuses tampering, unknown, wrong or misrestricted keys, synthetic data and noncanonical signatures', async () => {
  const { receipt, policy, keys } = await fixture();
  const unsortedBytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(receipt.payload).reverse())));
  assert.notEqual(new TextDecoder().decode(unsortedBytes), canonicalReceiptJson(receipt.payload));
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, unsortedBytes);
  const altered = [
    { ...receipt, payload: { ...receipt.payload, command: receipt.payload.command + 'x' } },
    { ...receipt, keyId: 'unknown' },
    { ...receipt, keyId: 'other' },
    { ...receipt, payload: { ...receipt.payload, synthetic: true } },
    { ...receipt, signature: Buffer.from(signature).toString('base64') },
  ];
  for (const value of altered) {
    assert.equal((await verifyImporterVerificationReceipt(value, policy)).valid, false);
  }
  for (const outsidePolicy of [{ ...policy, keys: {} }, { ...policy, environment: 'production' }]) {
    assert.equal((await verifyImporterVerificationReceipt(receipt, outsidePolicy)).valid, false);
  }
  // Only an omitted list or an array naming the environment admits a key; any other restriction fails closed.
  const production = (environments, environment = 'production') => ({ environment, keys: { stage: { publicKey: keys.publicKey, environments } } });
  const misrestricted = ['non-production', 'preproduction', null, false, 0, '', {}, new Set(['production'])].map((environments) => production(environments));
  for (const odd of [...misrestricted, production(undefined, ['production'])]) {
    assert.equal((await verifyImporterVerificationReceipt(receipt, odd)).valid, false);
  }
  assert.equal((await verifyImporterVerificationReceipt(receipt, production(['stage', 'production']))).valid, true);
  await assert.rejects(signImporterVerificationReceipt({ ...receipt.payload, synthetic: true }, 'stage', keys.privateKey));
});

test('signed receipts must include source digest and all schema counts, and nothing outside the schema', async () => {
  const { receipt, policy, keys } = await fixture();
  for (const remove of [
    (payload) => { delete payload.source.sha256; },
    (payload) => { delete payload.runs.apply.byKind; },
    (payload) => { delete payload.runs.dryRun.input; },
  ]) {
    const payload = structuredClone(receipt.payload);
    remove(payload);
    const bytes = new TextEncoder().encode(canonicalReceiptJson(payload));
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes)).toString('base64');
    assert.equal((await verifyImporterVerificationReceipt({ ...receipt, payload, signature }, policy)).valid, false);
  }
  // Members named after Object.prototype properties are unknown members too, in the envelope and in a payload.
  for (const name of ['constructor', '__proto__', 'toString']) {
    const published = JSON.parse(JSON.stringify(receipt).replace('{', `{${JSON.stringify(name)}:{"synthetic":true},`));
    const result = await verifyImporterVerificationReceipt(published, policy);
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues.map((issue) => issue.code), ['SCHEMA_ADDITIONAL_PROPERTY']);
    const payload = JSON.parse(canonicalReceiptJson(receipt.payload).replace('"source":{', `"source":{${JSON.stringify(name)}:"outside the schema",`));
    await assert.rejects(signImporterVerificationReceipt(payload, 'stage', keys.privateKey), /SCHEMA_ADDITIONAL_PROPERTY/);
  }
});

test('the evidence port admits verified only with a verifying receipt and preserves documented format', async () => {
  const f = await fixture();
  const documented = documentedFixture();
  const document = { ...f.document, importers: [...f.document.importers, ...documented.document.importers.map((row) => ({ ...row, incumbent: 'OtherDesk' }))] };
  const artifacts = new Map([...f.artifacts, ...documented.artifacts]);
  const port = createReceiptEvidencePort({ resolve: (link) => artifacts.get(link), trustedHosts: ['evidence.example.test', 'docs.example.test'] }, f.policy);
  const publish = (receipt) => {
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    artifacts.set(f.receiptLink, { url: f.receiptLink, bytes });
    Object.assign(document.importers[0].evidence, { sha256: digest(bytes), size: bytes.length });
  };
  publish(f.receipt);
  const before = structuredClone(document);
  const accepted = await validateImporters(document, port);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.issues));
  assert.equal(accepted.evidence.verifiedReceipts, 1);
  assert.deepEqual(document, before);
  publish({ ...f.receipt, keyId: 'other' });
  const refused = await validateImporters(document, port);
  assert.equal(refused.valid, false);
  assert.equal(refused.evidence.verifiedReceipts, 0);
  assert.equal((await validateImporters(documented.document, port)).valid, true);
  publish(f.receipt);
  const production = createReceiptEvidencePort(port, { ...f.policy, environment: 'production' });
  assert.equal((await validateImporters(document, production)).evidence.verifiedReceipts, 0);
});

test('Worker and Node exchange signed receipts using WebCrypto without nodejs_compat and judge export origins alike', async () => {
  const f = await fixture();
  // Origins whose URL/IDNA parse differs by runtime get the one verdict of the module's ASCII grammar in Node and the Worker.
  const origins = new Map([
    ['https://exampledesk.example.test/account/export', true], ['https://xn--a.test/export', true],
    ['https://xn--abc-.test/export', false], ['https://\u04c0.test/export', false],
  ]);
  const originReceipts = await Promise.all([...origins.keys()].map((origin) => signImporterVerificationReceipt(
    { ...f.payload, source: { ...f.payload.source, origin } }, 'stage', f.keys.privateKey)));
  const entry = fileURLToPath(new URL('../src/receipt/index.ts', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../src/receipt/', import.meta.url)), contents: `
      import { signImporterVerificationReceipt, verifyImporterVerificationReceipt } from ${JSON.stringify(entry)};
      export default { async fetch(request) {
        const input = await request.json();
        const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(input.publicKey), 'Ed25519', false, ['verify']);
        const policy = { environment: 'stage', keys: { stage: { publicKey, environments: ['stage'] } } };
        const accepted = await verifyImporterVerificationReceipt(input.receipt, policy);
        const refused = await verifyImporterVerificationReceipt(input.receipt, { ...policy, environment: 'production' });
        const origins = await Promise.all(input.originReceipts.map(async (receipt) => (await verifyImporterVerificationReceipt(receipt, policy)).valid));
        const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
        const receipt = await signImporterVerificationReceipt(input.receipt.payload, 'worker', keys.privateKey);
        return Response.json({ accepted, refused, origins, receipt, publicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) });
      } };
    ` },
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01' }));
  try {
    const response = await mf.dispatchFetch('https://receipt.test', {
      method: 'POST', body: JSON.stringify({ receipt: f.receipt, originReceipts, publicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', f.keys.publicKey))) }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.accepted.valid, true, JSON.stringify(result.accepted.issues));
    assert.equal(result.refused.valid, false);
    const node = await Promise.all(originReceipts.map(async (receipt) => (await verifyImporterVerificationReceipt(receipt, f.policy)).valid));
    assert.deepEqual({ node, worker: result.origins }, { node: [...origins.values()], worker: [...origins.values()] });
    const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(result.publicKey), 'Ed25519', false, ['verify']);
    assert.equal((await verifyImporterVerificationReceipt(result.receipt, { environment: 'stage', keys: { worker: { publicKey } } })).valid, true);
  } finally {
    await mf.dispose();
  }
});
