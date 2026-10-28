import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accessToken, autonomousPolicy, heldPolicy } from './crypto.mjs';
import { errorCode } from './protocol.mjs';

function matches(template, uri) {
 const pattern = template.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+');
 return new RegExp(`^${pattern}$`).test(uri);
}
async function events(c, token) {
 const found = []; let after;
 for (let page = 0; page < 100; page++) {
  const answer = await c.tool(`${c.surface.seed}.events.list`, { ...(after ? { after } : {}), limit: 200 }, token ? { token, track: false } : undefined);
  const content = answer.result?.structuredContent;
  if (!Array.isArray(content?.events)) throw new Error(`events.list failed (${errorCode(answer) ?? answer.status})`);
  found.push(...content.events);
  if (content.events.length < 200 || content.cursor === after) break;
  after = content.cursor;
 }
 return found;
}
// Read the prepared records' links, preferring one whose read policy holds it for approval.
async function readableLink(c, links) {
 let found;
 for (const uri of links) {
  const read = await c.mcp('resources/read', { uri });
  if (read.result?.contents?.length) found = { uri, held: read.decision?.classes?.some(item => item.class !== 'standard') };
  if (found?.held) return found;
 }
 return found;
}

/** Two agents of one sponsor keep their own grants. Resources, events and
 * subscriptions follow each agent's scopes; an approved read runs under the
 * original agent's grant and refuses once that grant is narrowed. */
export async function principalPhase(c, links) {
 const narrow = await accessToken(c, { act: { sub: `rer-conformance-narrow-${randomUUID()}`, name: 'Agent door conformance (events only)', specialist: c.surface.specialist }, scope: 'events:read' });
 const listed = async token => ((await c.mcp('resources/templates/list', {}, token ? { token } : {})).result?.resourceTemplates ?? []).map(item => item.uriTemplate).sort();
 const full = await listed(), limited = await listed(narrow), hidden = full.filter(template => !limited.includes(template));
 c.add('BASE-AGENT-004.principal.templates', limited.every(template => full.includes(template)), 'An agent with fewer scopes must list no resource template the fully granted agent cannot.');
 const found = await readableLink(c, links.filter(uri => hidden.some(template => matches(template, uri))));
 if (!found) return c.add('BASE-AGENT-004.principal.not-applicable', true);
 const { uri } = found, other = await c.mcp('resources/read', { uri }, { token: narrow, track: false });
 c.add('BASE-AGENT-004.principal.read', other.status === 403 && errorCode(other) === 'insufficient_scope', `Only an agent granted the scope of ${uri} may read it (${other.status} ${errorCode(other)}).`);
 const mine = await events(c), theirs = await events(c, narrow), scoped = event => hidden.some(template => matches(template, event.uri));
 c.add('BASE-AGENT-004.principal.events', mine.some(event => event.uri === uri) && !theirs.some(scoped), 'Events on a resource must reach only agents granted its scope, whatever their sponsor\'s role.');
 const subscribed = await c.listen([uri]), refused = await c.listen([uri], { token: narrow });
 c.add('BASE-AGENT-004.principal.subscriptions', isDeepStrictEqual(subscribed?.resourceSubscriptions, [uri]) && refused !== null && !refused.resourceSubscriptions?.includes(uri), 'A resource subscription must be honored only for an agent granted its scope.');
 if (!found.held) return;
 await c.adopt(heldPolicy());
 try {
  const held = await c.mcp('resources/read', { uri });
  // The same agent presents a narrower grant before a person approves its read.
  await c.tool(`${c.surface.seed}.events.list`, { limit: 1 }, { token: await accessToken(c, { scope: 'events:read' }) });
  const narrowed = await c.decideApproval(held), replay = await c.mcp('resources/read', { uri, requestState: held.body?.error?.data?.requestState });
  c.add('BASE-AGENT-004.principal.narrowed', narrowed.body?.approval?.state === 'refused' && narrowed.body.approval.code === 'insufficient_scope' && errorCode(replay) === 'insufficient_scope' && !replay.result?.contents, `An approved read must refuse with insufficient_scope once its agent's current grant lacks the scope (${narrowed.body?.approval?.state} ${narrowed.body?.approval?.code}).`);
  const again = await c.mcp('resources/read', { uri }), approved = await c.decideApproval(again), result = await c.mcp('resources/read', { uri, requestState: again.body?.error?.data?.requestState });
  c.add('BASE-AGENT-004.principal.approved', approved.body?.approval?.state === 'executed' && result.result?.contents?.length > 0, `An approved read must execute later under its agent's original grant (${approved.body?.approval?.state} ${errorCode(result)}).`);
 } finally { await c.adopt(autonomousPolicy()); }
}
