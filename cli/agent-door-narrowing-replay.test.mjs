import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureSeed } from './tests/fixtures/agent-door/seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { buildPackage } from '../scripts/rer-package.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('packed rer verify rejects injected narrowing replay, preserves valid replay and detects broken doors', { timeout: 240000 }, async t => {
 const packed = await mkdtemp(join(tmpdir(), 'rer-narrowing-cli-'));
 t.after(() => rm(packed, { recursive: true, force: true }));
 await run('tar', ['-xzf', await buildPackage(base, packed), '-C', packed]);
 await symlink(join(base, 'node_modules'), join(packed, 'package/node_modules'));
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 for (const mode of ['closed', 'declared', 'accepts-replay', 'refuses-with-effect']) {
  const root = await fixtureSeed(t, 'signed');
  const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
  surface.journey.find(step => step.id === 'revoke').inject = mode === 'declared'
   ? { id: { $from: 'create', pointer: '/id' } } : { grant_to_add: 'admin' };
  surface.verification.journey = 'narrowing-journey.mjs';
  await writeFile(surfaceFile, JSON.stringify(surface));
  await writeFile(join(root, 'narrowing-journey.mjs'), `
import assert from 'node:assert/strict';
export { default } from './journey.mjs';
export async function afterStep({ phase, step, args, result, database, tool }) {
 if (phase !== 'autonomous' || step.id !== 'revoke') return;
 const db = await database('DB');
 const state = async () => ({
  grants: (await db.prepare('SELECT COUNT(*) AS n FROM fixture_grants WHERE id=?').bind(args.id).first()).n,
  calls: (await db.prepare('SELECT COUNT(*) AS n FROM agent_door_calls WHERE key=?').bind(args.idempotency_key).first()).n,
  effects: (await db.prepare("SELECT COUNT(*) AS n FROM agent_door_events WHERE uri=? AND json_extract(event,'$.type')='grant.revoked'").bind('fixture://grant/' + args.id).first()).n,
 });
 assert.deepEqual(await state(), { grants: 0, calls: 1, effects: 1 });
 const injected = JSON.parse((await db.prepare("SELECT row FROM agent_door_audit WHERE json_extract(row,'$.idempotency_key')=? ORDER BY sequence DESC LIMIT 1").bind(args.idempotency_key).first()).row);
 ${mode === 'closed' ? `assert.equal(injected.code, 'invalid_arguments');
 assert.equal(injected.outcome, 'refused');` : `assert.equal(injected.outcome, 'replayed');`}
 console.error('PROBE ${mode} injected: prior revoke key + inject -> ' + (injected.code ?? injected.outcome));
 const replay = await tool(step.tool, args);
 assert.ok(replay.result && !replay.result.isError);
 assert.deepEqual(replay.result?.structuredContent, result);
 assert.deepEqual(await state(), { grants: 0, calls: 1, effects: 1 });
 console.error('PROBE ${mode} native: valid revoke replay -> success; grants=0 saved_calls=1 effects=1');
}
`);
  if (mode === 'accepts-replay' || mode === 'refuses-with-effect') {
   const guard = "if (tool.widens === false && row.ignored_arguments.length) return refuse('invalid_arguments')";
   // Deliberately broken real pipelines: fresh unknown arguments still refuse,
   // while the injected cached replay either succeeds or mutates before refusal.
   const replacement = `if (tool.widens === false && row.ignored_arguments.length) {
      const saved = await rt.options.db.prepare('SELECT outcome FROM agent_door_calls WHERE agent=? AND key=?').bind(principal.agent.id, claimKey).first()
      if (!saved?.outcome) return refuse('invalid_arguments')
      ${mode === 'refuses-with-effect' ? `await rt.options.db.prepare("INSERT INTO fixture_grants(id,scope,operator_id) VALUES(?,'admin',?)").bind(args.id, principal.person.id).run()
      return refuse('invalid_arguments')` : ''}
     }`;
   // The public verify command rebuilds the Worker; keep the broken pipeline
   // in that real build rather than changing an artifact it will overwrite.
   await writeFile(join(root, 'build-fixture.mjs'), `
import { readFile } from 'node:fs/promises';
import { buildFixture } from ${JSON.stringify(new URL('./tests/fixtures/agent-door/seed.mjs', import.meta.url).href)};
await buildFixture(process.cwd(), [{ name: 'narrowing-replay-door', setup(build) {
 build.onLoad({ filter: /agent-door\\/pipeline\\.ts$/ }, async ({ path }) => ({
  contents: (await readFile(path, 'utf8')).replace(${JSON.stringify(guard)}, ${JSON.stringify(replacement)}), loader: 'ts',
 }));
} }]);
`);
  }
  const output = await run(process.execPath, [join(packed, 'package/bin/rer.mjs'), 'verify', '--cwd', root, '--json'],
   { env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }).catch(error => error);
  const rows = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  const result = rows.findLast(row => row.agentDoor)?.agentDoor ?? {
   ok: false, points: output.stderr.split('\n').flatMap(line => {
    const match = /^(PASS|FAIL) (BASE-AGENT-\S+?)(?:: (.*))?$/.exec(line);
    return match ? [{ id: match[2], ok: match[1] === 'PASS', detail: match[3] }] : [];
   }),
  };
  const point = result.points.find(point => point.id === 'BASE-AGENT-005.5.autonomous.revoke');
  t.diagnostic(`PROBE ${mode} BASE-AGENT-005.5.autonomous.revoke: packed rer verify --json + revoke.inject -> ${point?.ok ? 'PASS' : 'FAIL'}; ${result.points.filter(point => point.ok).length}/${result.points.length} points`);
  assert.ok(point, output.stderr);
  assert.equal(point.ok, mode === 'closed' || mode === 'declared', JSON.stringify(point));
  if (mode === 'closed' || mode === 'declared') {
   assert.equal(result.ok, true, JSON.stringify(result.points.filter(point => !point.ok)));
   assert.match(output.stderr, /valid revoke replay -> success; grants=0 saved_calls=1 effects=1/);
   assert.ok(result.points.some(point => point.id === 'BASE-AGENT-012.1.autonomous' && point.ok));
  } else assert.equal(result.ok, false);
 }
});
