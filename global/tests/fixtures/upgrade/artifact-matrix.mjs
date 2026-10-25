// Real signed releases, Git candidates, snapshots and operation locks. Only the
// durable crash-stage records are constructed here; every verdict uses the tarball CLI.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeFixture } from './fixture.mjs';
import { stopOwnedApp } from './owned-app.mjs';
import { run } from '../../harness.mjs';
import { readJournal, rowCounts, snapshot, writeJSON, writeJournal } from '../../../local-run/state.mjs';
import { stateManifest } from '../../../local-run/state-manifest.mjs';
import { localOperation } from '../../../../onboarding/local/operation.mjs';

export const stages = ['intent', 'preparing', 'needs_integration', 'prepared', 'stopping',
 'switch_pending', 'switched', 'installed', 'started', 'verified', 'rolling_back', 'rollback_failed', 'complete', 'rolled_back'];
export const heads = ['same', 'reset', 'owner commit', 'other branch', 'detached', 'unborn'];
export const trees = ['clean', 'dirty tracked', 'untracked'];
export const locks = ['none', 'live second updater'];
export const protectedStages = new Set(['switch_pending', 'switched', 'installed', 'started', 'verified', 'rolling_back', 'rollback_failed']);
export const rollbackStages = new Set(['rolling_back', 'rollback_failed']);
const candidateHeadStages = new Set(['switched', 'installed', 'started', 'verified', 'complete']);
const bytes = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export function results(response) {
 return response.stdout.split('\n').flatMap(line => {
  try { const value = JSON.parse(line); return value.event === 'result' ? [value] : []; }
  catch { return []; }
 });
}

export async function artifactMatrix(t) {
 const f = await upgradeFixture(t, { checkoutName: 'matrix-owner-app' });
 await f.launch();
 const installedHead = await f.git(f.root, 'rev-parse', 'HEAD');
 const owner = await f.ownerCommit();
 await f.addRow();
 await stopOwnedApp(f.env, f.root);
 const localMarker = join(f.root, '.rer/local/matrix-owner.json');
 await mkdir(join(localMarker, '..'), { recursive: true });
 await writeFile(localMarker, '{"owner":"Keep this local customer state"}\n');
 const prepared = await f.run(['upgrade', '--to', f.v2.commit, '--anchors', f.anchors, '--check', '--json']);
 assert.equal(prepared.code, 0, 'the real signed preparation must succeed');
 const original = await readJournal(f.root);
 assert.equal(original.stage, 'prepared');
 assert.ok(original.prepared?.candidate, 'the matrix requires a real integrated candidate');
 original.wasRunning = false;
 original.runtimeSettled = true;
 const counts = await rowCounts(f.root);
 const backupName = await snapshot(f.root, { head: original.head, from: original.from, target: original.target, wasRunning: false });
 const backupDirectory = join(f.root, '.rer/upgrade/backups', backupName);
 const savedSnapshot = await stateManifest(backupDirectory);
 const savedData = await stateManifest(join(f.root, '.wrangler/state'));
 const next = await f.publish('3.0.0');
 const branchRef = `refs/heads/${original.branch}`;
 const otherBranch = 'matrix-owner-other-branch', unbornBranch = 'matrix-owner-unborn';
 const untrackedPath = join(f.root, 'matrix-owner-untracked.txt');
 const trackedPath = join(f.root, 'upstream-feature.txt');
 const journalPath = join(f.root, '.rer/upgrade/journal.json');
 const intentPath = join(f.root, '.rer/upgrade/intent.json');
 const git = args => run('git', args, { cwd: f.root, env: f.env });
 async function ref(refName) {
  const r = await git(['rev-parse', '--verify', refName]);
  assert.ok([0, 1, 128].includes(r.code), 'Git inspection must finish normally');
  return r.code === 0 ? r.stdout.trim() : null;
 }
 async function checkout(commit) {
  await f.git(f.root, 'symbolic-ref', 'HEAD', branchRef);
  await f.git(f.root, 'update-ref', branchRef, commit);
  await f.git(f.root, 'read-tree', '--reset', '-u', commit);
 }
 const ownerOriginal = await f.ownerCommit(owner.path, 'Later owner commit before the switch.\n');
 await checkout(original.prepared.candidate);
 const ownerCandidate = await f.ownerCommit(owner.path, 'Later owner commit after the switch.\n');
 await checkout(original.head);

 // Delete only artifacts created by this isolated fixture, after their bytes
 // have been observed. Recreate the original real candidate before each cell.
 async function clearPreparation(preparation) {
  if (!preparation) return;
  if (preparation.worktree && await exists(preparation.worktree)) await f.git(f.root, 'worktree', 'remove', '--force', preparation.worktree);
  await f.git(f.root, 'update-ref', '-d', `refs/heads/${preparation.branch}`);
 }
 async function put(cell) {
  const previous = await readJournal(f.root);
  const preparations = new Map([original.prepared, previous?.prepared].filter(Boolean).map(p => [p.branch, p]));
  for (const preparation of preparations.values()) await clearPreparation(preparation);
  await rm(untrackedPath, { force: true });
  await Promise.all([rm(journalPath, { force: true }), rm(intentPath, { force: true })]);
  const switched = candidateHeadStages.has(cell.stage);
  const expected = switched ? original.prepared.candidate : original.head;
  const commit = cell.head === 'reset' ? switched ? original.head : installedHead :
   cell.head === 'owner commit' ? switched ? ownerCandidate.commit : ownerOriginal.commit : expected;
  await checkout(commit);
  if (cell.head === 'other branch') {
   await f.git(f.root, 'update-ref', `refs/heads/${otherBranch}`, commit);
   await f.git(f.root, 'symbolic-ref', 'HEAD', `refs/heads/${otherBranch}`);
  } else if (cell.head === 'detached') await f.git(f.root, 'update-ref', '--no-deref', 'HEAD', commit);
  else if (cell.head === 'unborn') {
   await f.git(f.root, 'update-ref', '-d', `refs/heads/${unbornBranch}`);
   // Preserve index and owner files: an absent HEAD must be classified before
   // those existing files can be mistaken for an ordinary dirty installation.
   await f.git(f.root, 'symbolic-ref', 'HEAD', `refs/heads/${unbornBranch}`);
  }
  if (!['intent', 'preparing'].includes(cell.stage)) {
   await f.git(f.root, 'update-ref', `refs/heads/${original.prepared.branch}`, original.prepared.candidate);
   if (original.prepared.worktree) await f.git(f.root, 'worktree', 'add', '--quiet', original.prepared.worktree, original.prepared.branch);
  }
  if (cell.stage === 'intent') {
   await writeJSON(f.root, intentPath, { head: original.head, branch: original.branch, wasRunning: false });
  } else {
   const journal = structuredClone(original);
   journal.stage = cell.stage;
   delete journal.result;
   if (cell.stage === 'preparing') delete journal.prepared;
   if (cell.stage === 'needs_integration') journal.prepared.status = 'needs_integration';
   if (protectedStages.has(cell.stage) || ['complete', 'rolled_back'].includes(cell.stage)) {
    journal.backup = backupName; journal.counts = counts;
   } else { delete journal.backup; delete journal.counts; }
   await writeJournal(f.root, journal);
  }
  if (cell.tree === 'dirty tracked') await writeFile(trackedPath, `Owner tracked edit: ${JSON.stringify(cell)}\n`);
  if (cell.tree === 'untracked') await writeFile(untrackedPath, `Owner untracked edit: ${JSON.stringify(cell)}\n`);
  return observe();
 }
 async function observe() {
  const [journalBytes, intentBytes, candidate, head, branch, tracked, untracked, committedOwner, local, saved, data] = await Promise.all([
   bytes(journalPath), bytes(intentPath), ref(`refs/heads/${original.prepared.branch}`), ref('HEAD'),
   git(['symbolic-ref', '--quiet', '--short', 'HEAD']).then(r => r.code === 0 ? r.stdout.trim() : null),
   bytes(trackedPath), bytes(untrackedPath), bytes(join(f.root, owner.path)), bytes(localMarker),
   stateManifest(backupDirectory), stateManifest(join(f.root, '.wrangler/state')),
  ]);
  return { journalBytes, intentBytes, journal: journalBytes === null ? null : JSON.parse(journalBytes),
   candidate, head, branch, tracked, untracked, committedOwner, local, saved, data };
 }
 const invoke = cell => f.run(['upgrade', '--to', protectedStages.has(cell.stage) ? f.v1.commit : next.commit,
  '--anchors', f.anchors, '--check', '--json']);
 return { put, observe, invoke, hold: () => holdUpgradeOperation(f, t), next, savedSnapshot, savedData, backupName };
}

// A second process owns the real operation lock throughout the lock column.
// IPC carries readiness only; the lock capability never enters diagnostics.
async function holdUpgradeOperation(f, t) {
 const child = fork(fileURLToPath(import.meta.url), ['--hold-upgrade-operation', f.root], {
  env: f.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
 });
 const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
 const ready = new Promise(resolve => child.once('message', message => resolve(message?.event === 'locked')));
 let released = false;
 async function release() {
  if (released) return;
  released = true;
  if (child.connected) child.send({ event: 'release' });
  const result = await exited;
  assert.equal(result.code, 0, 'the owned lock holder must release cleanly');
 }
 t.after(release);
 const acquired = await Promise.race([ready, exited.then(() => false)]);
 assert.equal(acquired, true, 'the live second updater must acquire its real lock');
 return release;
}

if (process.argv[2] === '--hold-upgrade-operation' && process.send) {
 const operation = await localOperation(process.argv[3]);
 try {
  const released = new Promise(resolve => { process.once('message', resolve); process.once('disconnect', resolve); });
  process.send({ event: 'locked' });
  await released;
 } finally { await operation.release(); if (process.connected) process.disconnect(); }
}
