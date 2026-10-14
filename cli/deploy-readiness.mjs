// Mutation readiness errors carry confirmed state separately from the hosted
// response. Only show that response through the command's existing redactor.
export function mutationReadinessFailure(error, { again, redact }) {
 if (!error.secretChange) return undefined;
 const { binding, present } = error.secretChange;
 const last = error.attempts?.at(-1);
 const status = last?.status == null ? 'no HTTP response' : `HTTP ${last.status}`;
 const first = redact(String(last?.body ?? '').split(/[\r\n]/, 1)[0]).slice(0, 256);
 const state = error.ownerFinalization
  ? `Owner ${error.owner === 'kept' ? 'already claimed and kept' : 'claimed'}; setup token retirement was applied and its new Worker version recorded.`
  : `The secret change for ${binding} was applied and its new Worker version recorded.`;
 const step = error.ownerFinalization ? 'owner claim/token retirement' : `secret change for ${binding}`;
 const reason = /^[a-zA-Z0-9_-]{1,120}$/.test(error.message) ? error.message : 'health-check-failed';
 const retirement = error.ownerFinalization || binding === 'SETUP_TOKEN' && !present;
 return redact(`${state} Hosted readiness failed after ${step}. ${status} (${reason}).${first ? ` First response line: ${first}` : ''} Update the seed/app configuration to match the changed secrets and redeploy with ${again}. ${retirement ? 'If the app requires the spent setup token, remove that requirement from its configuration before redeploying; keep the recorded owner and token retirement.' : 'If the secret input was incorrect, correct it and apply the intended secret change again.'}`);
}
