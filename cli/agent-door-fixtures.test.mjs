import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { checkAgentDoor } from './agent-door.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('native client receipts and consumed phase state require real fresh fixtures through rer verify', { timeout: 420000 }, async t => {
 const root = await fixtureSeed(t, 'signed', { phaseFixtures: true });
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 async function verify() {
  const output = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }).catch(error => error);
  const rows = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.doesNotMatch(output.stdout + output.stderr, /fixture_native_[a-f0-9]{64}|operator_session=|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  const result = rows.findLast(row => row.agentDoor)?.agentDoor;
  if (result) return result;
  assert.ok(rows.some(row => row.code === 'agent_door_failed'), rows.map(row => row.code ?? row.event).join(', '));
  const points = output.stderr.split('\n').flatMap(line => {
   const match = /^(PASS|FAIL) (BASE-AGENT-\S+?)(?:: (.*))?$/.exec(line);
   return match ? [{ id: match[2], ok: match[1] === 'PASS', detail: match[3] }] : [];
  });
  assert.ok(points.length > 0, 'Failed verification must report its conformance points');
  return { ok: false, points };
 }
 const declared = await verify();
 assert.equal(declared.ok, true, JSON.stringify(declared.points.filter(point => !point.ok)));
 for (const round of ['autonomous', 'held', 'blocked.destructive']) assert.ok(declared.points.some(point => point.ok && point.id.includes(round) && point.id.endsWith('.erase')));
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 delete surface.verification.fixtures;
 await writeFile(surfaceFile, JSON.stringify(surface));
 const absent = await verify();
 assert.equal(absent.ok, false);
 assert.ok(absent.points.some(point => !point.ok && point.id.endsWith('.client')));
 surface.verification.fixtures = { module: 'missing-client.mjs' };
 await writeFile(join(root, 'missing-client.mjs'), "import prepare from './phase-fixtures.mjs'; export default async c => ({values:(await prepare(c)).values});\n");
 await writeFile(surfaceFile, JSON.stringify(surface));
 const noClient = await verify();
 assert.equal(noClient.ok, false);
 assert.ok(noClient.points.some(point => !point.ok && point.detail?.includes('native client fixture is unavailable')));
 surface.verification.fixtures = { module: 'stale-fixtures.mjs' };
 await writeFile(join(root, 'stale-fixtures.mjs'), "import prepare from './phase-fixtures.mjs'; let saved; export default async c => c.phase === 'initial' ? prepare(c) : saved ??= await prepare(c);\n");
 await writeFile(surfaceFile, JSON.stringify(surface));
 const stale = await verify();
 assert.equal(stale.ok, false);
 assert.ok(stale.points.some(point => !point.ok && point.id.includes('held') && point.id.endsWith('.erase')));
 t.diagnostic(`native/phase fixtures: declared ${declared.points.filter(point => point.ok).length}/${declared.points.length}; omitted ${absent.points.filter(point => !point.ok).length} failures; missing native client ${noClient.points.filter(point => !point.ok).length} failures; reused consumed state ${stale.points.filter(point => !point.ok).length} failures.`);
});

test('valid Business tokens refuse unknown, changed-email, inactive and excluded sponsors through the native door', { timeout: 420000 }, async t => {
 const root = await fixtureSeed(t, 'native');
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 const emails = Object.fromEntries(['inactive', 'excluded'].map(kind => [kind, `${kind}-${randomUUID()}@example.invalid`]));
 surface.verification.sponsors = [{ label: 'owner' }, ...Object.entries(emails).map(([label, email]) => ({ label, email, initializer: 'negative-sponsors.mjs', negativeOnly: true }))];
 surface.verification.fixtures = { module: 'negative-fixtures.mjs' };
 await writeFile(surfaceFile, JSON.stringify(surface));
 await writeFile(join(root, 'negative-sponsors.mjs'), `
import initialize from './second-sponsor.mjs';
export const sponsors = {};
export default async function(c) {
 let response;
 if (c.label === 'inactive') response = await initialize(c);
 else {
  // Accept the native invitation but leave this person outside the app's
  // membership allow-list. This is the real owner/session/account lifecycle.
  const db = await c.database('DB');
  const mail = await db.prepare('SELECT body FROM fixture_mail WHERE email=? ORDER BY rowid DESC LIMIT 1').bind(c.email).first();
  const link = new URL(mail.body.match(/https:\\/\\/[^\\s]+/)[0]);
  response = await c.request(c.origin + '/auth/confirm', { method: 'POST', redirect: 'manual',
   headers: { Origin: c.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link.searchParams.get('token') }) });
 }
 if (response.status !== 303) throw Error('Native invitation failed');
 sponsors[c.label] = { sub: c.sub, email: c.email };
 return response;
}
`);
 await writeFile(join(root, 'negative-fixtures.mjs'), `
import { sponsors } from './negative-sponsors.mjs';
export default async function({phase, request, origin, cookie}) {
 if (phase !== 'negative') return {};
 const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
 const listed = await request(origin + '/auth/operators', { headers });
 if (!listed.ok) throw Error('Native person list failed');
 const people = await listed.json(), inactive = people.find(person => person.email === sponsors.inactive.email);
 const suspended = await request(origin + '/auth/operator/status', { method: 'POST', headers,
  body: JSON.stringify({ operatorId: inactive.id, status: 'inactive' }) });
 if (!suspended.ok) throw Error('Native suspension failed');
 await suspended.body?.cancel();
 return { sponsors };
}
`);
 await buildFixture(root);
 const deployFile = join(root, 'deploy.json'), deploy = JSON.parse(await readFile(deployFile, 'utf8'));
 const kinds = ['unknown', 'changed-email', 'inactive', 'excluded'];
 async function verify(skip) {
  deploy.vars.SKIP_SPONSOR_CHECK = skip;
  await writeFile(deployFile, JSON.stringify(deploy));
  const lines = [], errors = [];
  const diagnostics = t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  let result;
  try { result = await checkAgentDoor(root, { report: line => lines.push(line) }); }
  catch (error) { result = error.agentDoor ?? error.details?.agentDoor; if (!result) throw error; }
  finally { diagnostics.mock.restore(); }
  const output = JSON.stringify({ lines, errors, result });
  for (const email of Object.values(emails)) assert.ok(!output.includes(email), 'Sponsor fixture email leaked into diagnostics');
  // The initializer retains the actual Business subjects only in its private module.
  const { sponsors } = await import(new URL('negative-sponsors.mjs', 'file://' + root + '/'));
  for (const person of Object.values(sponsors)) assert.ok(!output.includes(person.sub), 'Sponsor fixture subject leaked into diagnostics');
  return result;
 }
 const bypassed = await verify(true);
 for (const kind of kinds) assert.ok(bypassed.points.some(point => point.id === `BASE-AGENT-004.sponsor.${kind}` && !point.ok), `Skipped sponsor admission must fail ${kind}`);
 const native = await verify(false);
 assert.ok(!native.points.some(point => point.id.startsWith('BASE-AGENT-004.cross-sponsor')), 'Negative-only persons must not run successful cross-sponsor journeys');
 t.diagnostic(`Sponsor admission: ${JSON.stringify(native.points.filter(point => point.id.startsWith('BASE-AGENT-004.sponsor.')))}`);
 for (const kind of kinds) assert.ok(native.points.some(point => point.id === `BASE-AGENT-004.sponsor.${kind}` && point.ok), `Native sponsor admission must pass ${kind}`);
 t.diagnostic('Sponsor admission: bypassed adapter fails all four points; native adapter passes all four points.');
});
