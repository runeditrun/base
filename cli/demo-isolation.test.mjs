import '../modules/container/adapters/d1-workerd-preload.mjs';
import { retainStartupFailure } from './fixtures/command-diagnostic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../modules/container/adapters/d1-sqlite.mjs';
import { fixture, pause } from './fixtures/reference.mjs';

const events = child => child.stdoutText.trim().split('\n').filter(Boolean).map(JSON.parse);

async function stateFiles(directory) {
 const files = {};
 async function visit(path, relative = '') {
  for (const entry of await readdir(path, { withFileTypes: true })) {
   const name = relative ? relative + '/' + entry.name : entry.name, file = join(path, entry.name);
   if (entry.isDirectory()) await visit(file, name);
   else files[name] = { hash: createHash('sha256').update(await readFile(file)).digest('hex'), mode: (await stat(file)).mode };
  }
 }
 await visit(directory);
 return files;
}

test('rer demo refuses incomplete settings and serves isolated data without invoking legacy owner preflight', { timeout: 20 * 60_000 }, async t => {
 const f = await fixture('default-seed', t);
 await f.run(['install', '--json']);
 await f.run(['setup', '--owner-email', 'demo-owner@example.test', '--non-interactive', '--json']);
 // A pulled migration is absent from setup's old build but belongs in the demo.
 await writeFile(join(f.root, 'migrations/core/9998_demo_upgrade.sql'), 'CREATE TABLE demo_upgrade(value TEXT);\n');
 await f.sql("CREATE TABLE owner_saved(value TEXT); INSERT INTO owner_saved VALUES('owner content')");
 const settings = join(f.root, '.dev.vars'), privateBytes = await readFile(settings), privateMode = (await stat(settings)).mode;
 const ownerState = join(f.root, '.wrangler/state');
 // Keep a real WAL connection idle across both journeys so -wal and -shm are
 // present in every comparison, including the refused preflight.
 const databases = join(ownerState, 'v3/d1/miniflare-D1DatabaseObject');
 let ownerDb;
 for (const file of (await readdir(databases)).filter(name => name.endsWith('.sqlite'))) {
  const db = new DatabaseSync(join(databases, file));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_saved'").get()) { ownerDb = db; break; }
  db.close();
 }
 assert.ok(ownerDb);
 t.after(() => ownerDb.close());
 ownerDb.exec("PRAGMA journal_mode=WAL; UPDATE owner_saved SET value='owner content in WAL'");
 const before = await stateFiles(ownerState);
 assert.ok(Object.keys(before).some(name => name.endsWith('-shm')));
 assert.ok(Object.keys(before).some(name => name.endsWith('-wal')));
 const evidence = async (name, snapshot) => {
  if (process.env.RER_TEST_EVIDENCE_DIRECTORY) await writeFile(join(process.env.RER_TEST_EVIDENCE_DIRECTORY, `demo-owner-${name}.json`), JSON.stringify(snapshot, null, 2) + '\n');
 };
 await evidence('before', before);
 // Real older adapters validate the owner database and ignore the demo flag.
 // Record entry into that hook while preserving its real prerequisite logic.
 const adapter = join(f.root, 'scripts/installer/local.mjs'), adapterBytes = await readFile(adapter, 'utf8');
 const preflightRecord = join(f.root, 'owner-preflight-entered');
 await writeFile(adapter, adapterBytes + `
import { operatorPrerequisites as legacyPrerequisites } from '../base-onboarding/operator-prerequisites.mjs';
import { writeFile as recordPreflight } from 'node:fs/promises';
commandAdapter.localPrerequisites = async ({root, email}) => {
 await recordPreflight(root + '/owner-preflight-entered', 'entered');
 return legacyPrerequisites(root, email);
};
`);
 await writeFile(settings, privateBytes.toString('utf8').replace(/^SESSION_SECRET=.*\n?/m, ''), { mode: 0o600 });
 const incomplete = await readFile(settings);
 const refused = await f.run(['demo', '--json', '--foreground'], 3);
 assert.ok(!events(refused).some(event => event.event === 'ready'));
 assert.deepEqual(await readFile(settings), incomplete, 'refusal preserves saved settings');
 const refusedState = await stateFiles(ownerState);
 await evidence('refused', refusedState);
 assert.deepEqual(refusedState, before, 'refusal preserves every owner state file');
 await assert.rejects(access(preflightRecord), { code: 'ENOENT' });
 await writeFile(settings, privateBytes, { mode: 0o600 });

 const child = f.launch(['--import', join(import.meta.dirname,'fixtures/slow-state-inspection.mjs'), 'scripts/rer.mjs', 'demo', '--json', '--foreground']);
 try {
  const deadline = Date.now() + 180_000;
  while (!child.stdoutText.includes('"event":"ready"') && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(100);
  const ready = events(child).find(event => event.event === 'ready');
  if (!child.stdoutText.includes('"event":"ready"')) await retainStartupFailure(f.root, child);
  assert.ok(ready, 'the real demo reaches readiness');
  assert.equal((await fetch(ready.url + '/health')).status, 200);
  const directory = join(ready.demo.state, 'v3/d1/miniflare-D1DatabaseObject');
  let isolated = false;
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.sqlite'))) {
   const db = new DatabaseSync(join(directory, file), { readOnly: true });
   try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='rer_demo'").get()) continue;
    isolated = true;
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='demo_upgrade'").get(), 'demo applies the complete current source inventory');
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_saved'").get(), undefined, 'owner content is absent from the demo');
    assert.equal(db.prepare("SELECT email FROM oa_operators WHERE role='owner'").get().email, 'demo-owner@example.test');
   } finally { db.close(); }
  }
  assert.ok(isolated, 'the demo has its own guarded database and owner');
  await assert.rejects(access(preflightRecord), { code: 'ENOENT' });
  const servingState = await stateFiles(ownerState);
  await evidence('serving', servingState);
  assert.deepEqual(servingState, before, 'serving a demo preserves every owner state file');
  await f.run(['demo', '--stop', '--json']);
  assert.equal(await child.done, 0);
  await assert.rejects(access(ready.demo.state), { code: 'ENOENT' });
  const stoppedState = await stateFiles(ownerState);
  await evidence('stopped', stoppedState);
  assert.deepEqual(stoppedState, before, 'stopping a demo preserves every owner state file');
  assert.deepEqual(await readFile(settings), privateBytes);
  assert.equal((await stat(settings)).mode, privateMode);
  assert.equal(ownerDb.prepare('SELECT value FROM owner_saved').get().value, 'owner content in WAL');
 } finally {
  await f.stop(child);
  await writeFile(adapter, adapterBytes);
  await writeFile(settings, privateBytes, { mode: 0o600 });
 }
});
