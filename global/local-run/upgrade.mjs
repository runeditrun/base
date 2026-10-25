import { randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { serverResources } from '../../cli/server-resources.mjs';
import { compareVersion } from '../../modules/release/signature.mjs';
import { git, text } from './process.mjs';
import { failure, phases, errorCodes } from './error.mjs';
import { recordedRelease, resolveRelease } from './release.mjs';
import { prepareMerge, continueMerge, cleanupMerge } from './merge.mjs';
import { backup, readJournal, writeJournal, snapshot, rowCounts, checkPriorData, restoreState } from './state.mjs';
import { needsRecovery } from './journal.mjs';
import { readIntent, rememberIntent, forgetIntent } from './intent.mjs';
import { acquireOperation, returnOperation, runningApp, stopApp, startApp, health, verb } from './runtime.mjs';

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
 if (needsRecovery(journal)) throw failure('rollback_failed');
 if (journal.wasRunning && !await runningApp(checkout)) await health(checkout, await startApp(checkout, operation));
 if (journal.prepared) await cleanupMerge(checkout, journal.prepared);
 await rm(join(checkout, '.rer/upgrade/journal.json'), { force: true });
}
async function rollback(checkout, journal, operation) {
 const { metadata } = await backup(checkout, journal.backup);
 // The repair intent must outlive this process before any checkout, state or
 // runtime mutation. A retry may never mistake the old HEAD for restored data.
 journal.stage = 'rolling_back'; journal.runtimeSettled = false; delete journal.result;
 await writeJournal(checkout, journal);
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
 journal.stage = 'verified'; await writeJournal(checkout, journal);
}

/** Local signed updates. All private paths, database names/counts and subprocess
 * output stay in the local journal; only the design's closed outputs escape. */
export async function upgrade({ checkout, to, journalKey, anchors, onPhase, onDiagnostic, check = false, continue: continuing = false, restore, allowDataChange = [] } = {}) {
 const started = Date.now(), phase = phases(onPhase);
 let journal = {}, operation, installed, wasRunning, rememberedIntent = false, settleJournal = false, switched = false, preserveJournal = false, restoring = false;
 try {
  if (allowDataChange.length && !process.stdin.isTTY) throw failure('refused');
  try { checkout = await realpath(checkout); } catch { throw failure('checkout_missing'); }
  const loaded = await readJournal(checkout);
  preserveJournal = loaded !== null;
  journal = loaded ?? {};
  if (['rolling_back', 'rollback_failed'].includes(journal.stage) && !restore) {
   await phase('failed', 'rollback_failed');
   return output('refused', journal, started, 'rollback_failed');
  }
  try { installed = await recordedRelease(checkout); }
  catch (error) { if (!restore) throw error; }
  journal.from ??= installed;
  const current = await preflight(checkout);
  const terminalResume = ['complete', 'rolled_back'].includes(journal.stage) && journal.runtimeSettled === false;
  const unfinished = journal.version === 1 && (!['rolled_back', 'complete'].includes(journal.stage) || terminalResume);
  if (terminalResume && !restore && (journalKey && journal.journalKey && journalKey !== journal.journalKey || current.branch !== journal.branch ||
    current.head !== (journal.stage === 'complete' ? journal.prepared?.candidate : journal.head) ||
    installed?.commit !== (journal.stage === 'complete' ? journal.target?.commit : journal.from?.commit) ||
    to && ![journal.target?.commit, journal.target?.tag].includes(to))) throw failure('refused');
  if (needsRecovery(journal) && !restore && (current.branch !== journal.branch ||
    current.head !== journal.prepared?.candidate && !(journal.stage === 'switch_pending' && current.head === journal.head))) throw failure('rollback_failed');
  const intent = await readIntent(checkout);
  if (intent && !unfinished && (intent.head !== current.head || intent.branch !== current.branch)) throw failure('refused', 'An unfinished upgrade intent remains in .rer/upgrade/intent.json; keep it and recover the original checkout before upgrading.');
  wasRunning = unfinished && typeof journal.wasRunning === 'boolean' ? journal.wasRunning : intent?.wasRunning ?? Boolean(await runningApp(checkout));
  operation = await acquireOperation(checkout, async () => {
   if (!unfinished && !restore) {
    wasRunning = await rememberIntent(checkout, current, wasRunning); rememberedIntent = true;
   }
  });
  try { await serverResources(checkout, { env: { ...process.env, RER_SERVERS_LOAD_THRESHOLD: undefined } }); }
  catch { throw failure('disk_low'); }
  // Ensure private upgrade records never turn an otherwise clean seed dirty.
  if ((await git(checkout, ['check-ignore', '-q', '.rer/'], { allow: [1] })).code) {
   const exclude = await text(checkout, ['rev-parse', '--git-path', 'info/exclude']);
   const { appendFile } = await import('node:fs/promises');
   await appendFile(resolve(checkout, exclude), '\n.rer/\n', { mode: 0o600 });
  }
  if (restore) {
   preserveJournal = true;
   const repairPreparation = needsRecovery(journal) ? journal.prepared : undefined;
   const { metadata } = await backup(checkout, restore);
   journal = { ...journal, version: 1, head: metadata.head, branch: current.branch, from: metadata.from, target: metadata.target, backup: restore, wasRunning: metadata.wasRunning };
   restoring = true;
   await rollback(checkout, journal, operation);
   if (repairPreparation) {
    const ref = await git(checkout, ['show-ref', '--verify', '--quiet', `refs/heads/${repairPreparation.branch}`], { allow: [1] });
    if (!ref.code) await cleanupMerge(checkout, repairPreparation);
   }
   const result = output('rolled_back', journal, started);
   journal.result = result; await writeJournal(checkout, journal); settleJournal = true; await phase('ready');
   return result;
  }
  if (terminalResume) {
   // A kill after the verdict but before returning runtime custody must still
   // restore attempt one's running state. A settled journal is ordinary history.
   await stopApp(checkout, operation);
   if (journal.wasRunning) await health(checkout, await startApp(checkout, operation));
   const result = output(journal.stage === 'complete' ? 'updated' : 'rolled_back', journal, started,
    errorCodes.has(journal.result?.error_code) ? journal.result.error_code : undefined);
   journal.result = result; settleJournal = true;
   await phase(journal.stage === 'complete' ? 'ready' : 'failed', result.error_code);
   return result;
  }
  if (journalKey && journal.journalKey === journalKey && journal.result) {
   if (journal.wasRunning && !await runningApp(checkout)) await health(checkout, await startApp(checkout, operation));
   if (rememberedIntent) await forgetIntent(checkout);
   return journal.result;
  }
  if (journal.stage === 'verified') {
   if (current.head !== journal.prepared?.candidate || current.branch !== journal.branch || to && ![journal.target.commit, journal.target.tag].includes(to)) throw failure('refused');
   switched = true;
   if (journal.wasRunning) await health(checkout, (await runningApp(checkout))?.url ?? await startApp(checkout, operation));
   else await stopApp(checkout, operation);
   const result = output('updated', journal, started);
   journal.stage = 'complete'; journal.result = result; await writeJournal(checkout, journal); settleJournal = true;
   await cleanupMerge(checkout, journal.prepared); await phase('ready');
   return result;
  }
  if (unfinished) {
   if (journalKey && journal.journalKey && journalKey !== journal.journalKey) { preserveJournal = true; throw failure('refused'); }
   if (current.branch !== journal.branch) throw failure('not_on_branch');
   if (journal.prepared?.candidate && (current.head === journal.prepared.candidate || journal.stage === 'switch_pending' && current.head === journal.head) && ['switch_pending', 'switched', 'installed', 'started'].includes(journal.stage)) {
    switched = true;
    if (to && ![journal.target.commit, journal.target.tag].includes(to)) throw failure('refused');
    await stopApp(checkout, operation);
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
   } else { await discard(checkout, journal, operation); journal = {}; preserveJournal = false; }
  } else journal = {};
  if (!switched) {
   if (!journal.head) {
    if (continuing) throw failure('needs_integration');
    await phase('get');
    const from = await recordedRelease(checkout);
    const verifiedBase = await resolveRelease({ checkout, to: from.tag, repository: from.repository, anchors, fresh: true });
    if (verifiedBase.commit !== from.commit) throw failure('release_unverified', 'rer-upstream.json does not match its signed release.');
    const target = await resolveRelease({ checkout, to, repository: from.repository, anchors });
    if (compareVersion(target.tag.slice(1), from.tag.slice(1)) <= 0) throw failure('release_unverified');
    const ancestry = await git(checkout, ['merge-base', '--is-ancestor', from.commit, target.commit], { allow: [1] });
    if (ancestry.code) throw failure('release_unverified');
    journal = { version: 1, journalKey: journalKey ?? randomUUID(), checkout_name: basename(checkout), head: current.head, branch: current.branch, from, target, wasRunning, runtimeSettled: false, stage: 'preparing' };
    await writeJournal(checkout, journal);
    preserveJournal = false;
    await forgetIntent(checkout);
    try { journal.prepared = await prepareMerge({ checkout, base: from.commit, head: current.head, target: target.commit, tag: target.tag, repository: from.repository }); }
    catch (error) {
     journal.prepared ??= error.prepared;
     if (error.error_code === 'needs_integration' && error.prepared) {
      journal.prepared = error.prepared; journal.stage = 'needs_integration'; await writeJournal(checkout, journal);
     }
     throw error;
    }
    journal.stage = 'prepared'; await writeJournal(checkout, journal);
   }
   await forgetIntent(checkout);
   await phase('install');
   if (check) return output('refused', journal, started);
   await phase('database');
   journal.wasRunning ??= wasRunning;
   journal.stage = 'stopping'; await writeJournal(checkout, journal);
   await stopApp(checkout, operation);
   try {
    journal.counts = await rowCounts(checkout);
    journal.backup = await snapshot(checkout, { head: journal.head, from: journal.from, target: journal.target, wasRunning: journal.wasRunning });
   } catch (error) { throw error.error_code ? error : failure('database_failed'); }
   journal.stage = 'switch_pending'; await writeJournal(checkout, journal);
   switched = true;
   await apply(checkout, journal, operation, phase, allowDataChange);
  }
  const result = output('updated', journal, started);
  journal.stage = 'complete'; journal.result = result; await writeJournal(checkout, journal); settleJournal = true;
  await cleanupMerge(checkout, journal.prepared);
  await phase('ready');
  return result;
 } catch (error) {
  if (error.diagnostic) onDiagnostic?.(error.diagnostic);
  journal.from ??= installed;
  const code = !switched && needsRecovery(journal) && !restore ? 'rollback_failed' : errorCodes.has(error.error_code) ? error.error_code : 'refused';
  if (restoring) {
   journal.stage = 'rollback_failed'; await writeJournal(checkout, journal).catch(() => {});
   await phase('failed', 'rollback_failed');
   return output('refused', journal, started, 'rollback_failed');
  }
  if (switched) {
   try {
    await rollback(checkout, journal, operation);
    if (journal.prepared) await cleanupMerge(checkout, journal.prepared);
    const result = output('rolled_back', journal, started, code);
    journal.result = result; await writeJournal(checkout, journal); settleJournal = true; await phase('failed', code);
    return result;
   } catch {
    journal.stage = 'rollback_failed'; await writeJournal(checkout, journal).catch(() => {});
    await phase('failed', 'rollback_failed');
    return output('refused', journal, started, 'rollback_failed');
   }
  }
  if (preserveJournal) {
   if (operation && rememberedIntent) await forgetIntent(checkout);
   await phase('failed', code);
   return output('refused', journal, started, code);
  }
  if ((journal.wasRunning ?? wasRunning) && operation) {
   try { if (!await runningApp(checkout)) await health(checkout, await startApp(checkout, operation)); }
   catch {
    journal.stage = 'rollback_failed'; await writeJournal(checkout, journal).catch(() => {});
    await phase('failed', 'rollback_failed'); return output('refused', journal, started, 'rollback_failed');
   }
  }
  if (operation) await forgetIntent(checkout);
  if (operation && journal.head && code !== 'needs_integration') {
   try {
    if (journal.prepared) await cleanupMerge(checkout, journal.prepared);
    await rm(join(checkout, '.rer/upgrade/journal.json'), { force: true });
   } catch { /* Preserve a preparation somebody edited; never discard their work. */ }
  }
  await phase('failed', code);
  return output(code === 'needs_integration' ? 'needs_integration' : 'refused', journal, started, code);
 } finally {
  if (operation) {
   try {
    await returnOperation(checkout, operation);
    if (settleJournal) { journal.runtimeSettled = true; await writeJournal(checkout, journal); }
   } catch {
    onDiagnostic?.('Runtime custody could not be confirmed. Keep .rer/upgrade/journal.json and rerun rer upgrade to finish this attempt.');
    return output('refused', journal, started, 'refused');
   } finally { await operation.release(); }
  }
 }
}
