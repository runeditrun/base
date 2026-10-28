import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { auditRows } from './audit.mjs';
import { checkClasses } from './journey.mjs';
import { ERROR, errorCode } from './protocol.mjs';

/** A native-proof tool never runs on the agent's authority alone. Only the
 * seed's own check of the person's recent proof, at the handoff, admits it. */
export async function proofPhase(c, outputs) {
 for (const step of c.surface.proofs ?? []) await c.phase(`BASE-AGENT-005.proof.${step.id}`, async () => {
  if (typeof c.prove !== 'function') throw new Error('Native-proof fixtures need the seed\'s declared test proof (verification.proof).');
  const kind = c.surface.tools.find(tool => tool.name === step.tool).proof.native;
  const call = extra => c.tool(step.tool, { ...c.args(step, outputs), ...extra });
  const before = await c.witness(), challenge = await call(), proof = challenge.result?._meta?.[ERROR]?.proof, handoff = proof?.handoff;
  let url; try { url = new URL(handoff?.url); } catch { /* Reported by the challenge point. */ }
  c.add(`BASE-AGENT-005.proof.${step.id}.challenge`, errorCode(challenge) === 'native_proof_required' && proof?.kind === kind && typeof handoff?.id === 'string' && url?.origin === c.origin && !url.search && !url.hash && url.pathname.endsWith(`/${encodeURIComponent(handoff.id)}`) && isDeepStrictEqual(before, await c.witness()),
   `${step.tool} must refuse with native_proof_required, its proof kind and a same-origin handoff carrying no credential, without an effect (${errorCode(challenge) ?? challenge.status}).`);
  const row = (await auditRows(c)).rows.find(item => item.id === challenge.decision?.id);
  c.add(`BASE-AGENT-005.proof.${step.id}.audit`, row?.tool === step.tool && row.outcome === 'refused' && row.code === 'native_proof_required' && row.consent === c.consent && row.agent?.id === c.agentId && row.sponsor?.id === c.sponsor.id, `${step.tool} must audit its native-proof refusal completely.`);
  if (!url) return;
  const bogus = await call({ native_proof: `rer-conformance-bogus-${randomUUID()}` }), unproven = await call({ native_proof: handoff.id });
  c.add(`BASE-AGENT-005.proof.${step.id}.bogus`, errorCode(bogus) === 'native_proof_invalid' && errorCode(unproven) === 'native_proof_invalid' && isDeepStrictEqual(before, await c.witness()), `${step.tool} must refuse a bogus or unproven reference with native_proof_invalid and no effect (${errorCode(bogus)}, ${errorCode(unproven)}).`);
  await c.prove({ kind, handoff });
  const page = await c.personRequest(url.pathname);
  c.add(`BASE-AGENT-005.proof.${step.id}.handoff`, page.status === 200 && (await page.text()).includes('data-proof-state="confirmed"'), `The person's handoff page must show the seed's native proof as confirmed (HTTP ${page.status}).`);
  const proven = await call({ native_proof: handoff.id });
  checkClasses(c, step, proven, 'proof');
  c.add(`BASE-AGENT-005.proof.${step.id}.proven`, proven.status === 200 && !proven.result?.isError && proven.result?.resultType !== 'input_required' && proven.decision?.disposition === 'autonomous', `${step.tool} must run under policy after the seed's test proof (${errorCode(proven) ?? proven.status}).`);
 });
}
