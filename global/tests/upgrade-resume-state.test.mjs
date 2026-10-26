import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { upgradeFixture, ownerRow } from './fixtures/upgrade/fixture.mjs';
import { stopOwnedApp } from './fixtures/upgrade/owned-app.mjs';
import { liveServers } from '../registry.mjs';
import { stateManifest } from '../local-run/state-manifest.mjs';
import { readJournal } from '../local-run/state.mjs';
import { join } from 'node:path';

const result = r => r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).findLast(e => e.event === 'result');

test('resume and restore keep running intent while respecting later owner stops', { timeout: 20 * 60_000 }, async t => {
 const f = await upgradeFixture(t);
 await f.launch(); await f.ownerCommit(); await f.addRow();
 const running = async () => (await liveServers(f.env)).filter(r => r.checkout === f.root);
 for (const [index, [phase, initiallyRunning]] of [['get', true], ['install', true], ['ready', true], ['get', false]].entries()) {
  if (!initiallyRunning) await stopOwnedApp(f.env, f.root);
  const release = await f.publish(`3.${index}.0`);
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
  if (phase !== 'ready') {
   const deadline = Date.now() + 30_000;
   while ((await running()).length && Date.now() < deadline) await delay(100);
   assert.equal((await running()).length, 0);
  }
  const retry = await f.run(args);
  const retried = result(retry);
  assert.equal(retried.outcome, 'updated', retry.stderr);
  assert.equal(JSON.parse(await f.git(f.root, 'show', 'HEAD:rer-upstream.json')).commit, release.commit);
  assert.equal((await running()).length, initiallyRunning ? 1 : 0);
  if (initiallyRunning) assert.equal((await fetch(f.url + '/health')).status, 200);
  assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
  t.diagnostic(JSON.stringify({ phase, initiallyRunning, killedPid: child.pid, result: result(retry) }));
 }
 const records = join(f.root, '.rer/upgrade');
 const beforeRefusal = await stateManifest(records);
 const refused = await f.run(['upgrade', '--to', f.v1.commit, '--anchors', f.anchors, '--json']);
 assert.equal(result(refused).outcome, 'refused');
 assert.deepEqual(await stateManifest(records), beforeRefusal);
 assert.equal((await running()).length, 0);
 for (const [index, phase] of ['get', 'ready', 'start', 'check'].entries()) {
  assert.equal((await f.run(['dev', '--detach', '--json'])).code, 0);
  const baseline = await f.publish(`4.${index * 2}.0`);
  assert.equal(result(await f.run(['upgrade', '--to', baseline.commit, '--anchors', f.anchors, '--json'])).outcome, 'updated');
  const backup = (await readJournal(f.root)).backup;
  const release = await f.publish(`4.${index * 2 + 1}.0`);
  const args = ['upgrade', '--to', release.commit, '--anchors', f.anchors, '--json'];
  let killedPid = null;
  if (phase === 'check') assert.equal((await f.run([...args, '--check'])).code, 0);
  else {
   const child = f.start(args);
   const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
   let killed = false;
   child.stdout.on('data', () => {
    if (!killed && child.stdoutText.split('\n').some(line => {
     try { const e = JSON.parse(line); return e.event === 'phase' && e.phase === phase; } catch { return false; }
    })) { killed = true; child.kill('SIGKILL'); }
   });
   assert.equal((await exited).signal, 'SIGKILL'); killedPid = child.pid;
  }
  await stopOwnedApp(f.env, f.root);
  assert.equal((await f.run(['dev', '--detach', '--json'])).code, 0);
  await stopOwnedApp(f.env, f.root);
  await f.ownerCommit(`owner-stopped-before-restore-${phase}.md`, 'The owner stopped the app after the crash.\n');
  const selected = phase === 'start' ? (await readJournal(f.root)).backup : backup;
  const restored = await f.run(['upgrade', '--restore', selected, '--json']);
  assert.equal(result(restored).outcome, 'rolled_back', restored.stderr);
  assert.equal((await running()).length, 0);
  assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
  if (phase === 'check') {
   const upgraded = await f.run(args);
   assert.equal(result(upgraded).outcome, 'updated', upgraded.stderr);
   assert.equal((await running()).length, 0);
  }
  t.diagnostic(JSON.stringify({ phase, laterOwnerStop: true, killedPid, restore: result(restored), running: 0 }));
 }
});
