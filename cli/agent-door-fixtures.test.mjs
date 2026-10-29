import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

test('native continuation audits align later harness calls but unlinked embedded rows remain failures', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed', { phaseFixtures: true });
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 surface.verification.invoke = { module: 'invoke.mjs', entrypoint: 'NativeJobs' };
 for (const action of ['stage', 'continue']) surface.tools.push({ name: `fixture.records.${action}`, scope: 'records:write', readOnly: false, classes: [action === 'stage' ? 'standard' : 'external'], clauses: ['BASE-AGENT-009'] });
 surface.journey.splice(surface.journey.findIndex(step => step.id === 'create') + 1, 0,
  { id: 'stage', tool: 'fixture.records.stage', args: { value: 'Retained native record' }, expect: [{ class: 'standard', facts: { measure: 1 } }] },
  { id: 'continue', tool: 'fixture.records.continue', args: { id: { $from: 'stage', pointer: '/id' } }, expect: [{ class: 'external', facts: { measure: 1, counterparty: 'known' } }] },
 );
 await writeFile(surfaceFile, JSON.stringify(surface));
 const deployFile = join(root, 'deploy.json'), deploy = JSON.parse(await readFile(deployFile, 'utf8'));
 deploy.vars.CONTINUATION_PROOF = true;
 await writeFile(deployFile, JSON.stringify(deploy));
 const configFile = join(root, 'dist/server/wrangler.json'), config = JSON.parse(await readFile(configFile, 'utf8'));
 config.queues = { producers: [{ binding: 'JOBS', queue: 'fixture-jobs' }], consumers: [{ queue: 'fixture-jobs', max_batch_size: 1, max_batch_timeout: 0, max_retries: 0 }] };
 await writeFile(configFile, JSON.stringify(config));
 await buildFixture(root);
 const positive = await checkAgentDoor(root, { report: () => {} }).catch(error => { if (error.agentDoor) return error.agentDoor; throw error; });
 assert.equal(positive.ok, true, JSON.stringify(positive.points.filter(point => !point.ok)));
 const continuations = positive.points.filter(point => point.id.startsWith('BASE-AGENT-009.1.continuation.'));
 assert.ok(continuations.length > 0 && continuations.every(point => point.ok));
 assert.ok(positive.points.some(point => point.id === 'BASE-AGENT-009.1.events-audited' && point.ok));
 const invocations = positive.points.filter(point => point.id.startsWith('BASE-AGENT-012.invocation-'));
 assert.ok(invocations.length > 0 && invocations.every(point => point.ok));
 const repeated = { ...surface.journey.find(step => step.id === 'continue'), id: 'already-dispatched' };
 surface.journey.splice(surface.journey.findIndex(step => step.id === 'continue') + 1, 0, repeated);
 await writeFile(surfaceFile, JSON.stringify(surface));
 const refused = await checkAgentDoor(root, { report: () => {} }).catch(error => { if (error.agentDoor) return error.agentDoor; throw error; });
 assert.equal(refused.ok, false);
 assert.ok(refused.points.some(point => point.id === 'BASE-AGENT-009.1.count' && point.ok));
 assert.ok(refused.points.filter(point => point.id.startsWith('BASE-AGENT-008.5.execution.')).every(point => point.ok));
 for (const id of ['BASE-AGENT-007.5.receipt.already-dispatched', 'BASE-AGENT-013.4.held.already-dispatched']) assert.ok(refused.points.some(point => point.id === id && !point.ok));
 surface.journey.splice(surface.journey.indexOf(repeated), 1);
 await writeFile(surfaceFile, JSON.stringify(surface));
 deploy.vars.FABRICATE_CONTINUATION = true;
 await writeFile(deployFile, JSON.stringify(deploy));
 const negative = await checkAgentDoor(root, { report: () => {} }).catch(error => { if (error.agentDoor) return error.agentDoor; throw error; });
 assert.ok(negative && !negative.ok);
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-009.1.count' && !point.ok));
 assert.ok(negative.points.some(point => point.id.startsWith('BASE-AGENT-009.1.continuation.') && !point.ok));
 assert.ok(negative.points.some(point => point.id.startsWith('BASE-AGENT-009.1.extra.') && !point.ok));
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-007.7.differs-from-policy' && !point.ok));
 t.diagnostic(`Native continuations: ${positive.points.filter(point => point.ok).length}/${positive.points.length}; consumed native work: refused execution audited, receipt and completion fail; fabricated missing marker, unlinked operation, foreign agent/sponsor/consent/client and changed policy rule: rejected.`);
});
