import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { accessToken, autonomousPolicy, seconds, signJws } from './crypto.mjs';
import { schemaErrors } from './schema.mjs';
import { publicCode } from '../refusal-codes.mjs';

// BASE-AGENT-014. This verifier is the official-schema fake Business at the
// network edge: it signs the read credential with the installation's
// owner-claim key and validates every answer against the published schema.
export const DECISIONS_PATH = '/api/rer/agent-decisions';
export const decisionSchema = JSON.parse(readFileSync(new URL('../schema/door-decisions.schema.json', import.meta.url), 'utf8'));
const refusalSchema = { ...decisionSchema.$defs.refusal, $defs: decisionSchema.$defs };
const UNAUTHENTICATED = '{"code":"unauthenticated"}';

/** A read credential for `business` (the pairing's by default), with claim overrides. */
export async function readCredential(c, overrides = {}, { typ = 'rer-agent-decisions+jwt', privateKey = c.signer.privateKey, kid = c.signer.kid } = {}) {
 const iat = seconds(c.now);
 return signJws(privateKey, kid, typ, { iss: c.signer.issuer, aud: c.origin, sub: c.signer.installationId, business: c.business, iat, exp: iat + 300, ...overrides });
}

export async function readDecisions(c, { after, limit, token, business } = {}) {
 const query = new URLSearchParams();
 if (after !== undefined) query.set('after', after);
 if (limit !== undefined) query.set('limit', String(limit));
 const bearer = token === undefined ? await readCredential(c, business === undefined ? {} : { business }) : token;
 const response = await c.request(`${DECISIONS_PATH}${query.size ? `?${query}` : ''}`, { headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` } });
 const text = await response.text();
 let body; try { body = JSON.parse(text); } catch { body = undefined; }
 return { status: response.status, text, body, errors: schemaErrors(response.status === 200 ? decisionSchema : refusalSchema, body) };
}

/** Every page from `after`, as the Business per-installation loop reads it. */
export async function readAllDecisions(c, { after = '0', limit = 200, business } = {}) {
 const decisions = [], cursors = [];
 let cursor = after;
 for (let page = 0; page < 1000; page++) {
  const read = await readDecisions(c, { after: cursor, limit, business });
  if (read.status !== 200 || read.errors.length) return { ok: false, read, decisions, cursor, cursors };
  decisions.push(...read.body.decisions); cursors.push(read.body.cursor);
  cursor = read.body.cursor;
  if (read.body.decisions.length < limit) return { ok: true, decisions, cursor, cursors };
 }
 throw new Error('The decision read exceeded 1000 pages');
}

/** All audit rows, every agent and door, through the person audit API. */
export async function allAuditRows(c) {
 const rows = [];
 let cursor = null;
 for (let page = 0; page < 1000; page++) {
  const result = await c.personJson(`/agents/api/audit${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`);
  if (!Array.isArray(result.rows)) throw new Error('Audit API must return rows');
  rows.push(...result.rows);
  if (result.cursor == null || result.cursor === cursor) return rows;
  cursor = result.cursor;
 }
 throw new Error('Audit pagination exceeded 1000 pages');
}

/** Called before the first policy envelope: later rows belong to the pairing. */
export async function markPairing(c) {
 c.pairedThrough = Math.max(0, ...(await allAuditRows(c)).map(row => row.sequence));
}

/** Before a destructive call, keep what the Business read showed, to compare after erasure. */
export async function decisionSnapshot(c) {
 if (c.pairedThrough === undefined) return;
 const read = await readAllDecisions(c);
 if (!read.ok) throw new Error('Pre-erasure decision read failed');
 c.decisionEvidence ??= new Map();
 for (const decision of read.decisions) c.decisionEvidence.set(decision.id, decision);
}

const toolNames = c => new Set([...c.surface.tools.map(tool => tool.name), ...(c.invokeTools ?? []).map(tool => tool.name), 'resources/read', `${c.surface.seed}.events.list`]);
/** The row's projection, derived independently: an erased row from its pre-erasure evidence. */
export function projected(c, row) {
 const source = row.tombstone ? c.erasureEvidence?.get(row.id) : row;
 if (!source) return undefined;
 return { id: row.id, tool: toolNames(c).has(source.tool) ? source.tool : null, decision: source.decision, outcome: source.outcome,
  code: publicCode(source.outcome, source.code, c.surface.business?.refusalCodes ?? []), revision: source.revision ?? null, at: source.at,
  consent: source.door === 'mcp' ? source.consent ?? null : null };
}

const kinds = projection => [
 projection.outcome === 'done' && 'done', projection.decision === 'review' && 'review', projection.outcome === 'pending' && 'pending',
 projection.decision === 'blocked' && 'blocked', projection.decision === 'unset' && 'unset', projection.decision === 'paused' && 'paused',
 projection.decision === 'self_escalation' && 'self_escalation', projection.code === 'insufficient_scope' && 'scope-refused',
 projection.outcome === 'replayed' && 'replayed', projection.outcome === 'failed' && 'failed',
].filter(Boolean);

// Values a projection must never carry: targets, facts, keys, traces, names and person ids.
function privateValues(rows) {
 const values = new Set(), add = value => { if (typeof value === 'string' && value.length >= 10) values.add(value); };
 for (const row of rows) {
  add(typeof row.resource === 'string' ? row.resource : row.resource?.id);
  for (const item of row.classes ?? []) for (const value of Object.values(item.facts ?? {})) add(value);
  add(row.idempotency_key); add(row.trace); add(row.sponsor?.name); add(row.sponsor?.id); add(row.agent?.name);
  for (const name of row.ignored_arguments ?? []) add(name);
  for (const person of row.approval?.by ?? []) add(person);
  add(row.review?.by);
 }
 return values;
}

/** BASE-AGENT-014.1-.7 through the read door only. Run last: it re-pairs the installation and restores it. */
export async function decisionsPhase(c, { invoke, localCredential } = {}) {
 if (c.pairedThrough === undefined) throw new Error('The pairing was not marked before the first policy envelope');
 await c.adopt(autonomousPolicy());
 // A marked call: an ignored argument name and the trace id are unique markers.
 const marker = randomBytes(16).toString('hex'), witness = c.surface.witness;
 await c.mcp('tools/call', { name: witness.tool, arguments: { ...c.resolve(witness.args), [`rer_marker_${marker}`]: marker }, _meta: { traceparent: `00-${marker}-${randomBytes(8).toString('hex')}-01` } });
 if (invoke) await invoke(witness.tool, c.resolve(witness.args), { person: { id: c.sponsor.id }, agent: { id: c.agentId, name: 'Agent door conformance', specialist: c.surface.specialist }, consent: c.consent, scopes: [c.surface.tools.find(tool => tool.name === witness.tool).scope] });
 if (localCredential) await c.mcp('tools/call', { name: witness.tool, arguments: c.resolve(witness.args) }, { token: localCredential });
 // A seed whose fixtures can make a call fail declares it; the failed outcome must read back too.
 const failure = c.surface.business?.failure;
 if (failure) await c.tool(failure.tool, c.args(failure, new Map()));

 const rows = (await allAuditRows(c)).filter(row => row.sequence > c.pairedThrough);
 const all = await readAllDecisions(c);
 c.add('BASE-AGENT-014.1.schema', all.ok, `The decision read must answer 200 with the official schema: ${JSON.stringify(all.read?.errors ?? all.read?.status)}`);
 if (!all.ok) return;
 const byId = new Map(all.decisions.map(item => [item.id, item]));
 c.add('BASE-AGENT-014.1.one-per-row', byId.size === all.decisions.length && byId.size === rows.length && rows.every(row => byId.has(row.id)),
  `Every audit row of this pairing must read back once (${rows.length} rows, ${all.decisions.length} decisions).`);
 const unequal = rows.filter(row => projected(c, row) && !isDeepStrictEqual(byId.get(row.id), projected(c, row))).map(row => row.id);
 c.add('BASE-AGENT-014.1.fields', unequal.length === 0, `Projected fields differ from the audit row: ${unequal.slice(0, 5).join(', ')}`);
 const seen = new Set(all.decisions.flatMap(kinds));
 const required = ['done', 'review', 'pending', 'blocked', 'unset', 'paused', 'scope-refused', 'replayed', ...(c.surface.escalations?.length ? ['self_escalation'] : []), ...(failure ? ['failed'] : [])];
 c.add('BASE-AGENT-014.1.kinds', required.every(kind => seen.has(kind)), `The fixture week lacks: ${required.filter(kind => !seen.has(kind)).join(', ')}`);

 // .2: paused and unset keep their own decision, code and revision whatever Pause or the policy says later.
 const stopped = all.decisions.filter(item => ['paused', 'unset'].includes(item.decision) && item.outcome === 'refused');
 c.add('BASE-AGENT-014.2.recorded', ['paused', 'unset'].every(decision => stopped.some(item => item.decision === decision))
  && stopped.every(item => item.code === (item.decision === 'paused' ? 'agents_paused' : 'policy_unset')), 'A paused refusal must read paused/agents_paused and an unset one unset/policy_unset.');
 for (const [label, options] of [['paused', { paused: true }], ['resumed', {}]]) {
  await c.adopt(autonomousPolicy(), options);
  const again = await readAllDecisions(c), current = new Map(again.decisions.map(item => [item.id, item]));
  c.add(`BASE-AGENT-014.2.${label}`, again.ok && stopped.every(item => isDeepStrictEqual(current.get(item.id), item)), `Paused and unset decisions changed after policy ${label}.`);
 }

 // .3: small pages and a reader that resumes from only its saved cursor see the same ids in order.
 const paged = await readAllDecisions(c, { limit: 2 }), full = await readAllDecisions(c);
 const ids = list => list.map(item => item.id);
 c.add('BASE-AGENT-014.3.pages', paged.ok && isDeepStrictEqual(ids(paged.decisions), ids(full.decisions)) && paged.cursor === full.cursor, 'Paged reads must return the same ids in order with no gap.');
 let resumed = paged.ok;
 for (const [index, cursor] of paged.cursors.entries()) {
  const rest = await readAllDecisions(c, { after: cursor });
  resumed &&= rest.ok && isDeepStrictEqual(ids(rest.decisions), ids(full.decisions).slice((index + 1) * 2));
 }
 c.add('BASE-AGENT-014.3.restart', resumed, 'Resuming from a saved cursor must continue with the same ids, without gap or repeat.');
 const empty = await readDecisions(c, { after: full.cursor });
 c.add('BASE-AGENT-014.3.caught-up', empty.status === 200 && empty.body?.decisions.length === 0 && empty.body.cursor === full.cursor, 'Reading at the newest cursor must return nothing and keep the cursor.');

 // .4: no private value reaches a decision; undocumented codes read refused.
 const values = privateValues([...rows, ...c.erasureEvidence?.values() ?? []]);
 values.add(marker); values.add(`rer_marker_${marker}`);
 const text = JSON.stringify(full.decisions), leaked = [...values].filter(value => text.includes(value));
 c.add('BASE-AGENT-014.4.markers', rows.some(row => row.trace?.includes(marker)) && leaked.length === 0, `Decisions carry private values (${leaked.length}).`);
 const documented = new Set(c.surface.business?.refusalCodes ?? []);
 c.add('BASE-AGENT-014.4.codes', full.decisions.every(item => item.outcome === 'refused' ? typeof item.code === 'string' && (item.code === 'refused' || publicCode('refused', item.code, [...documented]) === item.code) : item.code === null),
  'A refused decision must carry a documented code or refused; every other outcome carries none.');

 // .5: consent only for tokens the paired Business issued.
 const consentRows = rows.filter(row => row.door === 'mcp' && row.consent === c.consent);
 c.add('BASE-AGENT-014.5.business', consentRows.length > 0 && consentRows.every(row => byId.get(row.id)?.consent === c.consent), 'Calls under the paired Business token must carry its consent id.');
 if (invoke) c.add('BASE-AGENT-014.5.embedded', rows.some(row => row.door === 'embedded') && rows.filter(row => row.door === 'embedded').every(row => byId.get(row.id)?.consent === null), 'Embedded calls must carry no consent.');
 if (localCredential) c.add('BASE-AGENT-014.5.own-credential', rows.some(row => row.door === 'mcp' && !row.consent) && rows.filter(row => row.door === 'mcp' && !row.consent).every(row => byId.get(row.id)?.consent === null), 'Calls under the seed\'s own credential must carry no consent.');

 // .6: strangers read nothing, with one indistinguishable answer.
 const foreign = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), iat = seconds(c.now);
 const strangers = [
  ['no-credential', null], ['agent-token', await accessToken(c)], ['foreign-key', await readCredential(c, {}, { privateKey: foreign.privateKey })],
  ['other-business', await readCredential(c, { business: `${c.business}-stranger` })], ['other-installation', await readCredential(c, { sub: randomUUID() })],
  ['other-audience', await readCredential(c, { aud: 'https://sibling.invalid' })], ['policy-envelope-type', await readCredential(c, {}, { typ: 'rer-agent-policy+jwt' })],
  ['expired', await readCredential(c, { iat: iat - 600, exp: iat - 1 })], ['lifetime', await readCredential(c, { iat, exp: iat + 301 })],
 ];
 for (const [label, token] of strangers) {
  const read = await readDecisions(c, { token });
  c.add(`BASE-AGENT-014.6.${label}`, read.status === 401 && read.text === UNAUTHENTICATED && !read.errors.length, `${label} read HTTP ${read.status}: ${read.text.slice(0, 80)}`);
 }
 const former = c.business, next = `${c.business}-next-${randomUUID().slice(0, 8)}`;
 const earlier = new Set((await allAuditRows(c)).map(row => row.id));
 try {
  c.business = next;
  await c.adopt(autonomousPolicy());
  const formerRead = await readDecisions(c, { business: former });
  c.add('BASE-AGENT-014.6.former-business', formerRead.status === 401 && formerRead.text === UNAUTHENTICATED, 'After another Business paired, the former Business must read nothing more.');
  const fresh = await readAllDecisions(c);
  c.add('BASE-AGENT-014.6.before-pairing', fresh.ok && fresh.decisions.every(item => !earlier.has(item.id)), 'A newly paired Business must read nothing from before its pairing.');
  const answer = await c.mcp('tools/call', { name: witness.tool, arguments: c.resolve(witness.args) });
  const own = await readAllDecisions(c), id = answer.decision?.id;
  c.add('BASE-AGENT-014.6.new-pairing', own.ok && !!id && own.decisions.some(item => item.id === id && item.tool === witness.tool) && own.decisions.every(item => !earlier.has(item.id)), 'The newly paired Business must read its own pairing\'s calls.');
 } finally {
  c.business = former;
  await c.adopt(autonomousPolicy());
 }

 // .7: an erased subject's calls still read the same value-free decisions.
 const erased = rows.filter(row => row.tombstone);
 if (!erased.length) { console.error('Business decisions: this run erased no subject; BASE-AGENT-014.7 not exercised.'); return; }
 const changed = erased.filter(row => !byId.has(row.id) || c.decisionEvidence?.has(row.id) && !isDeepStrictEqual(byId.get(row.id), c.decisionEvidence.get(row.id)));
 c.add('BASE-AGENT-014.7.erasure', erased.some(row => c.decisionEvidence?.has(row.id)) && changed.length === 0,
  `Erased calls must read the same value-free decisions (${erased.length} erased, ${changed.length} changed).`);
}
