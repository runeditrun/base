// Adapt these constants only in a reviewed change on the integration branch.
export const repository = 'runeditrun/base';
export const integrationRef = 'refs/heads/main';
// Only the trusted workflow environment supplies the destination; no dispatch input.
export function evidenceRepository(env = process.env) {
  const value = env.EVIDENCE_REPOSITORY;
  if (!/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\.git$/.test(value ?? ''))
    throw new Error('missing-or-invalid-evidence-repository');
  return value;
}
export const evidencePrefix = '3-foundation/T-002b';
export const providerSecrets = ['CF_THROWAWAY_API_TOKEN', 'CF_THROWAWAY_ACCOUNT_ID'];
export const proofs = Object.freeze({
  'secrets-present': Object.freeze(['node', 'live-proofs/secrets-present.mjs']),
  't016-r2-off': Object.freeze(['node', 'live-proofs/t016/r2-off.mjs']),
  't016-r2-on': Object.freeze(['node', 'live-proofs/t016/r2-on.mjs']),
  't016-upgrade-rollback': Object.freeze(['node', 'live-proofs/t016/upgrade-rollback.mjs']),
});
export const shaPattern = /^[0-9a-f]{40}$/;
export const releaseRefPattern = /^refs\/tags\/v[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function requireSha(value) {
  if (!shaPattern.test(value ?? '')) throw new Error('invalid-sha');
  return value;
}
export function requireProof(value) {
  if (!Object.hasOwn(proofs, value)) throw new Error('unknown-proof');
  return value;
}
