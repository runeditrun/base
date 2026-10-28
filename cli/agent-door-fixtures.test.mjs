import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixtureSeed } from './tests/fixtures/agent-door/seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

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
