import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accessToken, autonomousPolicy } from './crypto.mjs';
import { auditRows } from './audit.mjs';

/** Adapters enqueue and dispatch through the adopting application's public doors. */
export async function durablePhase(c, adapter) {
 if (typeof adapter?.queue !== 'function' || typeof adapter?.run !== 'function') throw new TypeError('Durable conformance requires queue and run public-door adapters');
 const request = (path, init) => {
  const url = new URL(path, `${c.origin}/`);
  if (url.origin !== c.origin) throw new Error('Durable adapter requests must use the installation origin');
  return c.request(url.href, init);
 };
 const consent = randomUUID(), token = await accessToken(c, { consent });
 const checkAudit = async (result, outcome, code) => {
  const { rows, differs } = await auditRows(c), row = rows.find(item => item.id === result.decision?.id);
  c.add(`BASE-AGENT-009.durable.${outcome}`, row?.door === 'embedded' && row.consent === consent && row.agent?.id === c.agentId && row.agent.specialist === c.surface.specialist && row.sponsor?.id === c.sponsor.id && typeof row.label === 'string' && row.label.includes(' for ') && Number.isFinite(Date.parse(row.at)) && row.outcome === outcome && row.code === code && typeof row.idempotency_key === 'string' && row.idempotency_key.length > 0 && Array.isArray(row.ignored_arguments) && row.revision === result.decision.revision && row.decision === result.decision.disposition && isDeepStrictEqual(row.classes, result.decision.classes.map(({ class: cls, facts }) => ({ class: cls, facts }))) && isDeepStrictEqual(row.rules, result.decision.classes.map(({ class: cls, rule, do: disposition }) => ({ class: cls, rule, do: disposition }))) && differs === 0, 'Durable execution must retain consent, agent, sponsor, key, policy decision and its completed outcome in its own audit row.');
 };
 await c.adopt(autonomousPolicy());
 try {
  const first = await adapter.queue({ request, token });
  const before = await c.witness(), completed = await adapter.run({ request, handle: first }), after = await c.witness();
  c.add('BASE-AGENT-004.durable.done', completed?.outcome === 'done' && !completed.code, 'Queued work must execute under the originating consent.');
  c.add('BASE-AGENT-004.durable.effect', !isDeepStrictEqual(before, after), 'The admitted durable execution must change native state.');
  await checkAudit(completed, 'done', null);
  await c.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [consent] } });
  // A native scheduler can enqueue again from retained attribution after the
  // bearer credential is revoked; it must not turn that into fresh authority.
  const second = await adapter.queue({ request, token, previous: first });
  const held = await c.witness(), refused = await adapter.run({ request, handle: second }), unchanged = await c.witness();
  c.add('BASE-AGENT-004.durable.revoked', refused?.outcome === 'refused' && refused.code === 'consent_revoked', 'Work scheduled from revoked consent must refuse with consent_revoked.');
  c.add('BASE-AGENT-004.durable.no-effect', isDeepStrictEqual(held, unchanged), 'Revoked durable work changed native state.');
  await checkAudit(refused, 'refused', 'consent_revoked');
 } finally { await c.adopt(autonomousPolicy()); }
}
