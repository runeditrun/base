export const publicSource = Object.freeze({ repository: 'https://github.com/just-every/happytohelp.git',
  ref: 'v0.2.1', sha: '59c6e2e1beb321e9f1cb5493efd05e20fc068638',
  previousRef: 'v0.2.0', previousSha: '3b34df590cff61358afc07ab56ea886461ca74fd' });
export const t016Proofs = Object.freeze({
  't016-r2-off': 'r2-off', 't016-r2-on': 'r2-on', 't016-upgrade-rollback': 'upgrade-rollback',
});
export const deploymentSecrets = Object.freeze(['CF_THROWAWAY_API_TOKEN', 'CF_THROWAWAY_ACCOUNT_ID']);
export const mailSecrets = Object.freeze(['T016_SENDGRID_API_KEY', 'T016_SENDGRID_FROM', 'T016_TEST_MAILBOX']);
export function secretsFor(proof, mailboxAdapter) {
  return proof === 't016-r2-off' ? deploymentSecrets : [...deploymentSecrets, ...mailSecrets,
    ...(mailboxAdapter === 'gmail' ? ['T016_GMAIL_ACCESS_TOKEN'] : [])];
}
