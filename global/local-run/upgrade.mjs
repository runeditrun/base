import { realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localOperation } from '../../onboarding/local/operation.mjs';
import { serverResources } from '../../cli/server-resources.mjs';
import { git, text } from './process.mjs';
import { failure, phases, errorCodes } from './error.mjs';
import { recordedRelease, resolveRelease } from './release.mjs';
import { prepareMerge, continueMerge, cleanupMerge } from './merge.mjs';
import { backup, readJSON, readJournal, writeJournal, writeJSON, snapshot, rowCounts, checkPriorData, restoreState } from './state.mjs';
import { runningApp, stopApp, startApp, health, verb } from './runtime.mjs';

const emptyConflicts = () => ({ public_paths: [], other_count: 0 });
function output(outcome, journal, started, error_code) {
 const release = outcome === 'updated' ? journal.target : journal.from;
 return { outcome, release_commit: release?.commit ?? '', ...(release?.tag ? { release_tag: release.tag } : {}),
  migrations_applied: outcome === 'updated' ? journal.prepared?.migrations_applied ?? [] : [],
  owner_changes_kept: journal.prepared?.owner_changes_kept ?? 0,
  conflicts: journal.prepared?.conflicts ?? emptyConflicts(), ...(error_code ? { error_code } : {}), duration_ms: Date.now() - started };
}
async function preflight(checkout) {
 try {
  if (await text(checkout, ['rev-parse', '--show-toplevel']) !== checkout) throw failure('checkout_missing');
 } catch { throw failure('checkout_missing'); }
 const branch = await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allow: [1] });
 if (!branch.stdout.trim()) throw failure('not_on_branch');
 if (await text(checkout, ['status', '--porcelain', '--untracked-files=all'])) throw failure('worktree_dirty');
 return { head: await text(checkout, ['rev-parse', 'HEAD']), branch: branch.stdout.trim() };
}
async function discard(checkout, journal, operation) {
 if (journal.wasRunning && !await runningApp(checkout)) await health(checkout, await startApp(checkout, operation));
 if (journal.prepared) await cleanupMerge(checkout, journal.prepared);
 await rm(join(checkout, '.rer/upgrade/journal.json'), { force: true });
}
async function rollback(checkout, journal, operation) {
 const { metadata } = await backup(checkout, journal.backup);
 await stopApp(checkout, operation);
 await git(checkout, ['reset', '--hard', metadata.head]);
 await restoreState(checkout, journal.backup);
 await verb(checkout, ['install', '--json'], operation);
 if (metadata.wasRunning) await health(checkout, await startApp(checkout, operation));
 journal.stage = 'rolled_back';
 await writeJournal(checkout, journal);
}
async function apply(checkout, journal, operation, phase, allowed) {
 // The switch intent is durable before fast-forward. On restart, HEAD decides
 // whether it happened, including a kill between Git and the next journal write.
 if (journal.stage === 'switch_pending') {
  await git(checkout, ['merge', '--ff-only', '--no-edit', journal.prepared.candidate]);
  journal.stage = 'switched'; await writeJournal(checkout, journal);
 }
 try { await verb(checkout, ['install', '--json'], operation); }
 catch { throw failure('install_failed'); }
 journal.stage = 'installed'; await writeJournal(checkout, journal);
 await phase('start');
 const url = await startApp(checkout, operation);
 journal.stage = 'started'; await writeJournal(checkout, journal);
 checkPriorData(journal.counts, await rowCounts(checkout), allowed);
 await health(checkout, url);
 if (!journal.wasRunning) await stopApp(checkout, operation);
 const { repository, tag, commit, verified_at } = journal.target;
 await writeJSON(checkout, join(checkout, '.rer/release.json'), { repository, tag, commit, verified_at });
 journal.stage = 'verified'; await writeJournal(checkout, journal);
}

/** Local signed updates. All private paths, database names/counts and subprocess
 * output stay in the local journal; only the design's closed outputs escape. */
export async function upgrade({ checkout, to, journalKey, anchors, onPhase, check = false, continue: continuing = false, restore, allowDataChange = [] } = {}) {
 const started = Date.now(), phase = phases(onPhase);
 let journal = {}, operation, installed, switched = false;
 try {
  if (allowDataChange.length && !process.stdin.isTTY) throw failure('refused');
  try { checkout = await realpath(checkout); } catch { throw failure('checkout_missing'); }
  installed = await recordedRelease(checkout).catch(() => undefined);
  journal.from = installed;
  const current = await preflight(checkout);
  operation = await localOperation(checkout);
  try { await serverResources(checkout, { env: { ...process.env, RER_SERVERS_LOAD_THRESHOLD: undefined } }); }
  catch { throw failure('disk_low'); }
  // Ensure private upgrade records never turn an otherwise clean seed dirty.
  if ((await git(checkout, ['check-ignore', '-q', '.rer/'], { allow: [1] })).code) {
   const exclude = await text(checkout, ['rev-parse', '--git-path', 'info/exclude']);
   const { appendFile } = await import('node:fs/promises');
   await appendFile(resolve(checkout, exclude), '\n.rer/\n', { mode: 0o600 });
  }
  journal = await readJournal(checkout) ?? {};
  if (restore) {
   const { metadata } = await backup(checkout, restore);
   journal = { version: 1, head: metadata.head, branch: current.branch, from: metadata.from, target: metadata.target, backup: restore, wasRunning: metadata.wasRunning };
   await rollback(checkout, journal, operation);
   const result = output('rolled_back', journal, started);
   journal.result = result; await writeJournal(checkout, journal); await phase('ready');
   return result;
  }
  if (journalKey && journal.journalKey === journalKey && journal.result) return journal.result;
  const unfinished = journal.version === 1 && !['verified', 'rolled_back', 'complete'].includes(journal.stage);
  if (unfinished) {
   if (journalKey && journal.journalKey && journalKey !== journal.journalKey) throw failure('refused');
   if (current.branch !== journal.branch) throw failure('not_on_branch');
   if (journal.prepared?.candidate && current.head === journal.prepared.candidate && ['switch_pending', 'switched', 'installed', 'started'].includes(journal.stage)) {
    switched = true;
    if (to && ![journal.target.commit, journal.target.tag].includes(to)) throw failure('refused');
    await phase('get');
    const verified = await resolveRelease({ checkout, to: journal.target.commit, repository: journal.from.repository, anchors });
    if (verified.commit !== journal.target.commit) throw failure('release_unverified');
    await apply(checkout, journal, operation, phase, allowDataChange);
   } else if (current.head !== journal.head) throw failure('refused');
   else if (journal.stage === 'needs_integration' && continuing) {
    await phase('get');
    journal.target = await resolveRelease({ checkout, to: journal.target.commit, repository: journal.from.repository, anchors });
    journal.prepared = await continueMerge({ checkout, ...journal.prepared });
    journal.stage = 'prepared';
   } else if (journal.stage === 'needs_integration') {
    await phase('failed', 'needs_integration');
    return output('needs_integration', journal, started, 'needs_integration');
   } else { await discard(checkout, journal, operation); journal = {}; }
  } else journal = {};
  if (!switched) {
   if (!journal.head) {
    if (continuing) throw failure('needs_integration');
    await phase('get');
    const from = await recordedRelease(checkout);
    const target = await resolveRelease({ checkout, to, repository: from.repository, anchors });
    const ancestry = await git(checkout, ['merge-base', '--is-ancestor', from.commit, target.commit], { allow: [1] });
    if (ancestry.code) throw failure('release_unverified');
    journal = { version: 1, journalKey, head: current.head, branch: current.branch, from, target, stage: 'preparing' };
    await writeJournal(checkout, journal);
    try { journal.prepared = await prepareMerge({ checkout, base: from.commit, head: current.head, target: target.commit, tag: target.tag, repository: from.repository }); }
    catch (error) {
     if (error.error_code === 'needs_integration' && error.prepared) {
      journal.prepared = error.prepared; journal.stage = 'needs_integration'; await writeJournal(checkout, journal);
     }
     throw error;
    }
    journal.stage = 'prepared'; await writeJournal(checkout, journal);
   }
   await phase('install');
   if (check) return output('refused', journal, started);
   await phase('database');
   journal.wasRunning = Boolean(await runningApp(checkout));
   journal.stage = 'stopping'; await writeJournal(checkout, journal);
   await stopApp(checkout, operation);
   try {
    journal.counts = await rowCounts(checkout);
    journal.backup = await snapshot(checkout, { head: journal.head, from: journal.from, target: journal.target, wasRunning: journal.wasRunning,
     release: await readJSON(join(checkout, '.rer/release.json')) });
   } catch (error) { throw error.error_code ? error : failure('database_failed'); }
   journal.stage = 'switch_pending'; await writeJournal(checkout, journal);
   switched = true;
   await apply(checkout, journal, operation, phase, allowDataChange);
  }
  const result = output('updated', journal, started);
  journal.stage = 'complete'; journal.result = result; await writeJournal(checkout, journal);
  await cleanupMerge(checkout, journal.prepared);
  await phase('ready');
  return result;
 } catch (error) {
  journal.from ??= installed;
  const code = errorCodes.has(error.error_code) ? error.error_code : 'refused';
  if (switched) {
   try {
    await rollback(checkout, journal, operation);
    const result = output('rolled_back', journal, started, code);
    journal.result = result; await writeJournal(checkout, journal); await phase('failed', code);
    return result;
   } catch {
    journal.stage = 'rollback_failed'; await writeJournal(checkout, journal).catch(() => {});
    await phase('failed', 'rollback_failed');
    return output('refused', journal, started, 'rollback_failed');
   }
  }
  if (journal.wasRunning && operation) {
   try { if (!await runningApp(checkout)) await health(checkout, await startApp(checkout, operation)); }
   catch { await phase('failed', 'rollback_failed'); return output('refused', journal, started, 'rollback_failed'); }
  }
  await phase('failed', code);
  return output(code === 'needs_integration' ? 'needs_integration' : 'refused', journal, started, code);
 } finally { await operation?.release(); }
}
