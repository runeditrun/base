import { isDeepStrictEqual } from 'node:util';
import { errorCode, ERROR } from './protocol.mjs';

export async function proofOptions(c, step, args) {
 const tool = c.surface.tools.find(tool => tool.name === step.tool);
 if (!tool?.proof) return {};
 if (typeof c.prove !== 'function') throw new Error(`${tool.name} requires its seed-declared native proof driver`);
 return { proofReference: await c.prove({ tool: tool.name, kind: tool.proofKind, arguments: args }) };
}
export async function checkProofChallenge(c, step, args) {
 const tool = c.surface.tools.find(tool => tool.name === step.tool), before = await c.witness();
 const challenge = await c.tool(step.tool, args), bogus = await c.tool(step.tool, args, { proofReference: 'bogus-native-proof-reference' });
 for (const [name, answer] of [['missing', challenge], ['bogus', bogus]]) {
  const fields = answer.result?._meta?.[ERROR];
  let handoff; try { handoff = new URL(fields?.handoff); } catch {}
  c.add(`BASE-AGENT-004.native-proof.${step.id}.${name}`, errorCode(answer) === 'native_proof_required' && fields?.kind === tool.proofKind && handoff?.origin === c.origin && !handoff.username && !handoff.password, `${tool.name} must challenge missing/bogus proof with its kind and same-origin human handoff.`);
 }
 c.add(`BASE-AGENT-004.native-proof.${step.id}.no-effect`, isDeepStrictEqual(before, await c.witness()), `${tool.name} changed native state without native proof.`);
 // auditPhase checks each challenge's complete ordered audit row.
}
async function grants(c, step, outputs) {
 const answer = await c.tool(step.witness.tool, c.resolve(step.witness.args, outputs));
 const result = answer.result?.structuredContent, subject = c.resolve(step.subject, outputs);
 if (answer.result?.isError || result?.subject !== subject || !Array.isArray(result.grants)
  || result.grants.some(grant => typeof grant !== 'string') || new Set(result.grants).size !== result.grants.length) throw new Error(`${step.tool}: witness must return {subject,grants:string[]} for the targeted subject`);
 return result.grants;
}
export async function narrowingBefore(c, step, args, outputs) {
 const before = await grants(c, step, outputs), native = await c.witness();
 const answer = await c.tool(step.tool, { ...args, ...c.resolve(step.smuggle, outputs) });
 c.add(`BASE-AGENT-005.narrowing.${step.tool}.undeclared`, errorCode(answer) === 'invalid_arguments' && isDeepStrictEqual(before, await grants(c, step, outputs)) && isDeepStrictEqual(native, await c.witness()), `${step.tool} must refuse undeclared widening arguments with no effect.`);
 return before;
}
export async function narrowingAfter(c, step, before, outputs) {
 const after = await grants(c, step, outputs);
 c.add(`BASE-AGENT-005.narrowing.${step.tool}.subset`, after.every(grant => before.includes(grant)) && after.length < before.length, `${step.tool} must remove a grant for the targeted subject; after must be a strict subset of before.`);
}
