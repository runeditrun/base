import { isDeepStrictEqual } from 'node:util';
import { classIds } from './protocol.mjs';

async function auditRows(c) {
 const rows = []; let cursor = null, differs = 0;
 for (let page = 0; page < 100; page++) {
  const result = await c.personJson(`/agents/api/audit?agent=${encodeURIComponent(c.agentId)}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
  if (!Array.isArray(result.rows) || !Number.isInteger(result.differs_from_policy)) throw new Error('Audit API must return rows and differs_from_policy');
  rows.push(...result.rows); differs += result.differs_from_policy;
  if (!result.rows.length || result.cursor === cursor) return { rows, differs };
  cursor = result.cursor;
 }
 throw new Error('Audit pagination exceeded 100 pages');
}
export async function auditPhase(c) {
 const { rows, differs } = await auditRows(c), expected = [...c.calls];
 c.add('BASE-AGENT-009.1.count', rows.length === expected.length, `Expected exactly ${expected.length} audit rows for tools/call, found ${rows.length}.`);
 for (const [index, call] of expected.entries()) {
  const row = rows[index], decision = call.decision;
  c.add(`BASE-AGENT-009.1.call.${index}`, Boolean(row) && row.tool === call.name && row.agent?.id === c.agentId && row.agent?.specialist === c.surface.specialist && Boolean(row.sponsor?.id) && typeof row.label === 'string' && row.label.includes(' for ') && Number.isFinite(Date.parse(row.at)) && row.door === 'mcp', `${call.name} lacks its complete ordered audit row.`);
  if (!row) continue;
  c.add(`BASE-AGENT-006.6.audit.${index}`, isDeepStrictEqual(classIds(row.classes), classIds(decision?.classes)) && (!decision || decision.classes.every(item => row.classes.some(actual => actual.class === item.class && isDeepStrictEqual(actual.facts, item.facts)))), `${call.name} audit classes/facts differ from its computed decision.`);
  if (decision) c.add(`BASE-AGENT-009.2.decision.${index}`, row.id === decision.id && row.decision === decision.disposition && row.revision === decision.revision && isDeepStrictEqual(row.rules, decision.classes.map(({ class: cls, rule, do: disposition }) => ({ class: cls, rule, do: disposition }))), `${call.name} audit decision or revision differs from the response.`);
  if (decision?.disposition === 'review') c.add(`BASE-AGENT-009.4.review.${index}`, Boolean(row.review?.id), `${call.name} was decided review without a review row.`);
  if (call.result?._meta?.['com.runeditrun/receipt']) c.add(`BASE-AGENT-008.5.audit.${index}`, Boolean(row.approval?.id) && row.approval.by?.includes(row.sponsor.id), `${call.name} approval receipt lacks the signed-in sponsor as approver.`);
 }
 c.add('BASE-AGENT-007.7.differs-from-policy', differs === 0, `Audit evidence has ${differs} decisions that differ from the policy in force.`);
 // Audit is read before the events tool: its own call is audited as well, but
 // cannot occur in a snapshot taken before it was made.
 const events = []; let after;
 for (let page = 0; page < 100; page++) {
  const result = await c.tool(`${c.surface.seed}.events.list`, { ...(after ? { after } : {}), limit: 200 });
  const content = result.result?.structuredContent;
  if (!Array.isArray(content?.events)) throw new Error('events.list did not return {events,cursor}');
  events.push(...content.events);
  if (content.events.length < 200 || content.cursor === after) break;
  after = content.cursor;
 }
 c.add('BASE-AGENT-010.2.events', events.length > 0 && new Set(events.map(event => event.id)).size === events.length && events.every(event => typeof event.id === 'string' && typeof event.type === 'string' && typeof event.uri === 'string' && event.actor && Number.isFinite(Date.parse(event.at))), 'Events must have stable unique ids, type, URI, actor and time.');
 for (const type of ['policy.adopted', 'approval.pending', 'approval.decided']) {
  const applicable = type === 'policy.adopted' || rows.some(row => row.approval);
  if (applicable) c.add(`BASE-AGENT-010.6.${type}`, events.some(event => event.type === type), `Missing ${type} event.`);
 }
 const writeTools = new Set(rows.filter(row => ['done', 'replayed'].includes(row.outcome) && !c.surface.tools.find(tool => tool.name === row.tool)?.readOnly).map(row => row.tool));
 c.add('BASE-AGENT-010.1.effects', !writeTools.size || events.some(event => event.actor?.kind === 'agent' && !['policy.decision', 'approval.pending', 'approval.decided'].includes(event.type)), 'Completed writes must produce record-change events attributed to the agent.');
 if (events.length > 1) {
  const cursor = events[0].id;
  const replay1 = await c.tool(`${c.surface.seed}.events.list`, { after: cursor, limit: 200 });
  const replay2 = await c.tool(`${c.surface.seed}.events.list`, { after: cursor, limit: 200 });
  const ids = result => result.result?.structuredContent?.events?.map(event => event.id) ?? [];
  const first = ids(replay1), second = ids(replay2);
  c.add('BASE-AGENT-010.3.cursor', first.length > 0 && isDeepStrictEqual(first, second.slice(0, first.length)) && first[0] === events[1].id, 'Replaying one cursor must return the same retained event ids in order.');
 }
 const final = await auditRows(c);
 c.add('BASE-AGENT-009.1.events-audited', final.rows.length === c.calls.length && final.differs === 0, `events.list audit calls mismatch: ${final.rows.length} audit rows for ${c.calls.length} calls.`);
}
