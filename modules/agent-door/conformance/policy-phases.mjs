import { isDeepStrictEqual } from 'node:util';
import { webcrypto } from 'node:crypto';
import { autonomousPolicy, policyEnvelope, signJws, seconds } from './crypto.mjs';
import { errorCode } from './protocol.mjs';
import { nativeStepHook } from './step-hooks.mjs';

export async function unsetPolicy(c, initial = false) {
 const listed = await c.mcp('tools/list');
 c.add(`BASE-AGENT-007.2.${initial ? 'initial' : 'removed'}.list`, isDeepStrictEqual(listed.result?.tools, []), 'An unanswered door must list no tools.');
 if (initial) {
  const inventory = await c.personJson('/agents/api/agents');
  const sponsor = inventory.agents?.find(agent => agent.id === c.agentId)?.sponsor;
  c.add('BASE-AGENT-004.6.sponsor', typeof sponsor?.id === 'string' && sponsor.id.length > 0, 'The native person agents inventory must identify the authenticated agent sponsor.');
  if (!sponsor?.id) throw new Error('Cannot resolve native sponsor ID from the person agents door');
  c.sponsor.id = sponsor.id;
  await c.prepare('initial');
 }
 for (const step of c.surface.journey) {
  // No prior result exists here; unresolved references cannot identify native
  // records. Resolvable calls still retain their computed classification.
  const answer = await c.stepTool(step, c.args(step, new Map(), { unresolved: true }));
  c.add(`BASE-AGENT-007.2.${initial ? 'initial' : 'removed'}.${step.id}`, errorCode(answer) === 'policy_unset', `${step.tool} must refuse with policy_unset before setup.`);
 }
}
export async function removalPhase(c) {
 await c.adopt(autonomousPolicy());
 await c.prepare('removed');
 const before = await c.witness();
 await c.adopt(null);
 await unsetPolicy(c);
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-007.2.unset-no-effect', isDeepStrictEqual(before, await c.witness()), 'Calls under the removed policy changed native state.');
 await renewalRefusals(c);
}
async function renewalRefusals(c) {
 const adopted = c.adoptedPolicy, now = seconds(c.now);
 const state = await c.personJson('/agents/api/state'), approvals = await c.personJson('/agents/api/approvals'), before = await c.witness();
 const sign = payload => signJws(c.signer.privateKey, c.signer.kid, 'rer-agent-policy+jwt', payload);
 const later = { ...adopted, iat: adopted.iat + 1, exp: now + 300 };
 const changed = autonomousPolicy(); changed.rules = [{ id: 'all', class: '*', do: 'blocked' }];
 const foreign = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const altered = await policyEnvelope(c, changed, { seq: adopted.seq, revision: adopted.revision, iat: later.iat });
 const revised = await policyEnvelope(c, adopted.document, { seq: adopted.seq, iat: later.iat });
 const business = await policyEnvelope({ ...c, business: `${c.business}-other` }, adopted.document, { seq: adopted.seq, revision: adopted.revision, iat: later.iat });
 const resigned = await policyEnvelope({ ...c, signer: { ...c.signer, privateKey: foreign.privateKey } }, adopted.document, { seq: adopted.seq, revision: adopted.revision, iat: later.iat });
 // Use a fresh trusted revision signature to prove that even equivalent
 // evidence cannot replace the exact adopted revision signature at equal seq.
 const revisionClaims = JSON.parse(Buffer.from(adopted.revision_signature.split('.')[1], 'base64url').toString());
 const freshSignature = await signJws(c.signer.privateKey, c.signer.kid, 'rer-agent-policy-revision+jwt', revisionClaims);
 const cases = [
  ['expired', await sign({ ...later, exp: now - 1 }), 'policy_invalid', 400],
  ['untrusted', await signJws(foreign.privateKey, c.signer.kid, 'rer-agent-policy+jwt', later), 'policy_invalid', 400],
  ['revision-mismatch', await sign({ ...later, document: changed }), 'policy_revision_invalid', 400],
  ['equal-iat', await sign({ ...later, iat: adopted.iat }), 'policy_stale', 409],
  ['earlier-iat', await sign({ ...later, iat: adopted.iat - 1 }), 'policy_stale', 409],
  ['document', altered.policy, 'policy_stale', 409],
  ['revision', revised.policy, 'policy_stale', 409],
  ['business', business.policy, 'policy_stale', 409],
  ['paused', await sign({ ...later, paused: !adopted.paused }), 'policy_stale', 409],
  ['revoked', await sign({ ...later, revoked: { agents: [c.agentId], consents: [c.consent] } }), 'policy_stale', 409],
  ['revision-signature', await sign({ ...later, revision_signature: freshSignature }), 'policy_stale', 409],
  ['untrusted-revision', await sign({ ...later, revision_signature: resigned.payload.revision_signature }), 'policy_revision_invalid', 400],
 ];
 for (const [name, policy, code, status] of cases) {
  const response = await c.request('/api/rer/agent-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) });
  const body = await response.json();
  const call = await c.tool(c.surface.witness.tool, c.resolve(c.surface.witness.args));
  c.add(`BASE-AGENT-007.7.renew.${name}`, response.status === status && body.code === code &&
   isDeepStrictEqual(state, await c.personJson('/agents/api/state')) && isDeepStrictEqual(approvals, await c.personJson('/agents/api/approvals')) &&
   !call.result?.isError && isDeepStrictEqual(before, call.result?.structuredContent), `${name} must refuse ${code} without changing policy, approvals or native state.`);
 }
}
export async function blockedPhases(c) {
 const nonstandard = [...new Set(c.surface.tools.flatMap(tool => tool.classes))].filter(cls => cls !== 'standard');
 for (const cls of nonstandard) {
  await c.adopt(autonomousPolicy());
  await c.prepare(`blocked:${cls}`);
  const outputs = new Map();
  for (const step of c.surface.journey) {
   const args = c.args(step, outputs);
   await nativeStepHook(c, 'beforeStep', `blocked:${cls}`, step, args, outputs);
   if (step.expect.some(item => item.class === cls)) {
    const policy = autonomousPolicy(); policy.rules.push({ id: `block-${cls}`, class: cls, do: 'blocked' });
    await c.adopt(policy);
    const before = await c.witness(), refused = await c.stepTool(step, args), after = await c.witness();
    c.add(`BASE-AGENT-007.1.blocked.${cls}.${step.id}`, errorCode(refused) === 'policy_blocked' && refused.decision?.disposition === 'blocked' && refused.decision.revision === c.revision && refused.decision.classes.some(item => item.class === cls && item.do === 'blocked'), `${step.tool} must be blocked by ${cls}.`);
    c.add(`BASE-AGENT-007.1.blocked-no-effect.${cls}.${step.id}`, isDeepStrictEqual(before, after), `${step.tool} changed native state while ${cls} was blocked.`);
    await c.adopt(autonomousPolicy());
   }
   const completed = await c.stepTool(step, args, await c.proof(step.tool, args, undefined, step.client));
   if (completed.result?.isError || completed.result?.structuredContent === undefined) throw new Error(`Could not prepare ${step.id} for the ${cls} blocked variant (${errorCode(completed) ?? completed.status})`);
   outputs.set(step.id, completed.result.structuredContent);
   await nativeStepHook(c, 'afterStep', `blocked:${cls}`, step, args, outputs, completed.result.structuredContent);
  }
 }
}
export async function pausePhase(c) {
 await c.adopt(autonomousPolicy());
 await c.prepare('paused');
 const before = await c.witness();
 await c.adopt(autonomousPolicy(), { paused: true });
 for (const tool of c.surface.tools) {
  const step = c.surface.journey.find(item => item.tool === tool.name);
  const paused = await c.stepTool(step, c.args(step, new Map(), { unresolved: true }));
  c.add(`BASE-AGENT-011.6.pause.${tool.name}`, errorCode(paused) === 'agents_paused', `${tool.name} ran while Business Pause was set.`);
 }
 const state = await c.personJson('/agents/api/state');
 c.add('BASE-AGENT-011.6.person', state.paused?.business === true, 'The signed-in person must still read paused state.');
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-011.6.resume', isDeepStrictEqual(before, await c.witness()), 'Pause calls changed native state, or resume did not restore access.');
}

export async function consentRevocationPhase(c) {
 await c.adopt(autonomousPolicy());
 await c.prepare('consent');
 const before = await c.witness();
 await c.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [c.consent] } });
 const step = c.surface.journey[0];
 const refused = await c.tool(step.tool, c.args(step, new Map(), { unresolved: true }));
 c.add('BASE-AGENT-004.consent-revoked', refused.status === 401, 'A revoked originating consent must refuse the next authenticated call.');
 await c.adopt(autonomousPolicy());
 c.add('BASE-AGENT-004.consent-no-effect', isDeepStrictEqual(before, await c.witness()), 'A call under revoked consent changed native state.');
}
