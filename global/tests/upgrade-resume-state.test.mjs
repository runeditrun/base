import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { upgradeFixture, ownerRow } from './fixtures/upgrade/fixture.mjs';
import { stopOwnedApp } from './fixtures/upgrade/owned-app.mjs';
import { liveServers } from '../registry.mjs';

const result = r => r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).findLast(e => e.event === 'result');

test('resume keeps the running state from before the first attempt, including before release fetch', { timeout: 20 * 60_000 }, async t => {
 const f = await upgradeFixture(t);
 await f.launch(); await f.ownerCommit(); await f.addRow();
 const running = async () => (await liveServers(f.env)).filter(r => r.checkout === f.root);
 for (const [phase, initiallyRunning] of [['get', true], ['install', true], ['get', false]]) {
  if (!initiallyRunning) await stopOwnedApp(f.env, f.root);
  const release = await f.publish(`3.${phase === 'install' ? 1 : initiallyRunning ? 0 : 2}.0`);
  const args = ['upgrade', '--to', release.commit, '--anchors', f.anchors, '--json'];
  const child = f.start(args);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let killed = false;
  child.stdout.on('data', () => {
   if (!killed && child.stdoutText.split('\n').some(line => {
    try { const e = JSON.parse(line); return e.event === 'phase' && e.phase === phase; } catch { return false; }
   })) { killed = true; child.kill('SIGKILL'); }
  });
  assert.equal((await exited).signal, 'SIGKILL');
  const deadline = Date.now() + 30_000;
  while ((await running()).length && Date.now() < deadline) await delay(100);
  assert.equal((await running()).length, 0);
  const retry = await f.run(args);
  assert.equal(result(retry).outcome, 'updated', retry.stderr);
  assert.equal((await running()).length, initiallyRunning ? 1 : 0);
  if (initiallyRunning) assert.equal((await fetch(f.url + '/health')).status, 200);
  assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
  t.diagnostic(JSON.stringify({ phase, initiallyRunning, killedPid: child.pid, result: result(retry) }));
 }
});
