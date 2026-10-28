import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { auditRows } from './audit.mjs';
import { checkClasses } from './journey.mjs';
import { errorCode } from './protocol.mjs';

/** A durable job keeps the consent its agent acted under. It runs while that
 * consent stands; once Business revokes it, the job's final admission refuses. */
export async function durablePhase(c, outputs) {
 if (!c.surface.durable?.length) return;
 if (typeof c.jobs !== 'function') return c.add('BASE-AGENT-004.durable.runner', false, 'Durable fixtures need the verifier to run the seed\'s scheduled jobs.');
 const original = c.consent;
 // Each job run is an embedded execution; its audit row joins the ordered call record.
 const run = async () => {
  const seen = new Set((await auditRows(c)).rows.map(row => row.id));
  await c.jobs();
  const rows = (await auditRows(c)).rows.filter(row => !seen.has(row.id) && row.door === 'embedded');
  for (const row of rows) c.calls.push({ kind: 'durable/execute', name: row.tool, decision: null, consent: row.consent, outcome: row.outcome, code: row.code });
  return rows;
 };
 try {
  for (const step of c.surface.durable) await c.phase(`BASE-AGENT-004.durable.${step.id}`, async () => {
   const consent = c.consent = `rer-conformance-durable-${randomUUID()}`;
   const scheduled = await c.tool(step.tool, c.args(step, outputs));
   checkClasses(c, step, scheduled, 'durable');
   c.add(`BASE-AGENT-004.durable.${step.id}.schedule`, !scheduled.result?.isError, `${step.tool} must schedule durable work (${errorCode(scheduled) ?? scheduled.status}).`);
   const before = await c.witness(), ran = await run(), after = await c.witness();
   c.add(`BASE-AGENT-004.durable.${step.id}.run`, ran.length === 1 && ran[0].tool === step.runs && ran[0].outcome === 'done' && ran[0].consent === consent && ran[0].agent?.id === c.agentId && ran[0].sponsor?.id === c.sponsor.id && !isDeepStrictEqual(before, after), `The scheduled ${step.runs} job must run once under its consent, change native state and record an embedded audit row naming that consent.`);
   const again = await c.tool(step.tool, c.args(step, outputs));
   if (again.result?.isError) throw new Error(`Could not schedule the second ${step.id} job (${errorCode(again) ?? again.status})`);
   await c.adopt(c.document, { revoked: { agents: [], consents: [consent] } });
   c.consent = `rer-conformance-durable-${randomUUID()}`;
   const held = await c.witness(), refused = await run();
   c.add(`BASE-AGENT-004.durable.${step.id}.revoked`, refused.length === 1 && refused[0].tool === step.runs && refused[0].outcome === 'refused' && refused[0].code === 'consent_revoked' && refused[0].consent === consent && refused[0].agent?.id === c.agentId && refused[0].sponsor?.id === c.sponsor.id && typeof refused[0].label === 'string' && Number.isFinite(Date.parse(refused[0].at)) && isDeepStrictEqual(held, await c.witness()), `After Business revokes its consent, the scheduled ${step.runs} job must refuse with consent_revoked, no effect and a complete audit row.`);
  });
 } finally { c.consent = original; }
 await c.adopt(c.document);
}
