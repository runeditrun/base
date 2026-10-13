import { insist, digest } from '../../scripts/qualification/operations.mjs';
import { hostedOrigin } from '../../scripts/qualification/http.mjs';
export const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
export const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+<>/-]{0,255}$/.test(x);
export const utc = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && !Number.isNaN(Date.parse(x));
const yes = x => x === true;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const origin = x => { try { return hostedOrigin(x) === x; } catch { return false; } };
const stage = x => ['initial', 'upgrade', 'rollback'].includes(x);
const image = x => /^(?:sha256:[a-f0-9]{64}|ghcr\.io\/runeditrun\/t016-(controller|build|browser)@sha256:[a-f0-9]{64})$/.test(x ?? '');
const migration = x => typeof x === 'string' && /^\d+_[a-z0-9_-]+\.sql$/.test(x);
export const failureCodes = ['missing-secret', 'live-environment-required', 'mailbox-choice-pending',
 'mailbox-adapter-unsupported', 'reviewed-runtime-unconfigured', 'isolation-unqualified', 'r2-disabled-confirmed', 'qualification-failed'];
const schemas = {
 boundary: { code: x => failureCodes.includes(x) },
 isolation: { controllerSha: sha, attestation: hash, controllerImage: image, buildImage: image, browserImage: image },
 source: { sourceSha: sha, documentsSha256: hash, migrationsSha256: hash, release: x => ['0.2.0', '0.2.1'].includes(x) },
 dependencies: { sourceSha: sha, runtimeImage: image, exitCode: x => x === 0 },
 target: { origin, worker: x => /^t016-[0-9]+-[0-9]+$/.test(x ?? '') },
 setup: { stage, databaseId: id, databaseName: id, worker: id, bucket: id,
  queues: x => Array.isArray(x) && x.length > 0 && x.length <= 4 && x.every(id) && new Set(x).size === x.length },
 build: { sourceSha: sha, artifactSha256: hash, configSha256: hash, workerSha256: hash, fileCount: integer, runtimeImage: image },
 deploy: { stage, origin, worker: id, deploymentId: id, versionId: id, sourceSha: sha, artifactSha256: hash, workerSha256: hash, assetsSha256: hash },
 health: { stage, origin, database: x => x === 'reachable', files: x => x === 'reachable' },
 widget: { origin, scriptSha256: hash, pageErrors: x => x === 0, desktop: yes, mobile: yes },
 owner: { ownerId: id, projectId: id, setupClosed: yes, loginVerified: yes },
 reply: { conversationId: id, visitorId: id, visitorMessageId: id, operatorMessageId: id, requestSha256: hash, replySha256: hash,
  socketEventId: x => /^[1-9][0-9]*$/.test(String(x)), reloadVerified: yes, replayVerified: yes },
 media: { conversationId: id, mediaId: id, sha256: hash, size: x => integer(x) && x > 0 },
 migrations: { stage, ledgerSha256: hash, sourceMigrationsSha256: hash, names: x => Array.isArray(x) && x.length > 0 && x.every(migration) && new Set(x).size === x.length },
 upgrade: { sourceSha: sha, previousVersionId: id, versionId: id, rowsSha256: hash, mediaSha256: hash, ledgerSha256: hash, loginVerified: yes },
 rollback: { sourceSha: sha, previousVersionId: id, versionId: id, rowsSha256: hash, mediaSha256: hash, ledgerSha256: hash, loginVerified: yes },
 sendgrid: { provider: x => x === 'sendgrid', providerMessageId: id, correlation: x => /^t016-[a-f0-9]{32}$/.test(x ?? ''), state: x => x === 'sent' },
 mailbox: { adapter: x => x === 'gmail', mailboxMessageId: id, messageId: x => typeof x === 'string' && /^<[A-Za-z0-9._:@+/-]{1,254}>$/.test(x), receivedUtc: utc,
  correlation: x => /^t016-[a-f0-9]{32}$/.test(x ?? ''), contentSha256: hash },
 r2: { status: x => [400,403].includes(x), code: x => Number.isSafeInteger(x) && x > 0 },
};
export function validateFacts(phase, facts) {
  const schema = schemas[phase];
  insist(schema && facts && Object.getPrototypeOf(facts) === Object.prototype &&
   JSON.stringify(Object.keys(facts).sort()) === JSON.stringify(Object.keys(schema).sort()) &&
   Object.entries(schema).every(([key, validate]) => validate(facts[key])), 'invalid-observation-facts');
  return facts;
}
export function observation(phase, facts, passed = true) {
  validateFacts(phase, facts); return { phase, passed, facts, sha256: digest(facts), utc: new Date().toISOString() };
}
