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
import { needsRecovery, artifactOutcome } from './journal.mjs';
import { readIntent, rememberIntent, forgetIntent, intendedRunning } from './intent.mjs';
import { acquireOperation, assertOperationAvailable, returnOperation, runningApp, stopApp, startApp, health, verb } from './runtime.mjs';

import { preflight, discard } from './preparation.mjs';

const emptyConflicts = () => ({ public_paths: [], other_count: 0 });
function output(outcome, journal, started, error_code) {
 const release = outcome === 'updated' ? journal.target : journal.from;
 return { outcome, release_commit: release?.commit ?? '', ...(release?.tag ? { release_tag: release.tag } : {}),
  migrations_applied: outcome === 'updated' ? journal.prepared?.migrations_applied ?? [] : [],
  owner_changes_kept: journal.prepared?.owner_changes_kept ?? 0,
  conflicts: journal.prepared?.conflicts ?? emptyConflicts(), ...(error_code ? { error_code } : {}), duration_ms: Date.now() - started };
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
export async function upgrade({ checkout, to, journalKey, anchors, onPhase, onDiagnostic, onRecovery, check = false, continue: continuing = false, restore, allowDataChange = [] } = {}) {
 const started = Date.now(), phase = phases(onPhase);
 let journal = {}, operation, installed, wasRunning, settleJournal = false, switched = false, preserveJournal = false, restoring = false;
 try {
  if (allowDataChange.length && !process.stdin.isTTY) throw failure('refused');
  try { checkout = await realpath(checkout); } catch { throw failure('checkout_missing'); }
  const loaded = await readJournal(checkout);
  journal = loaded ?? {};
  preserveJournal = loaded !== null;
  const intent = await readIntent(checkout);
  await assertOperationAvailable(checkout);
  const current = await preflight(checkout);
  try { installed = await recordedRelease(checkout); }
  catch (error) { if (!restore) throw error; }
  journal.from ??= installed;
  const protectedJournal = needsRecovery(journal);
  if (protectedJournal && !restore) {
   if (current.branch !== journal.branch) throw failure('not_on_branch', 'The interrupted upgrade belongs to a different branch. Return to that branch before recovery.');
   if (['rolling_back', 'rollback_failed'].includes(journal.stage)) {
    onRecovery?.(); await phase('failed', 'rollback_failed');
    return output('refused', journal, started, 'rollback_failed');
   }
   if (current.head !== journal.prepared?.candidate && !(journal.stage === 'switch_pending' && current.head === journal.head)) {
    throw failure('refused', 'HEAD moved after an interrupted upgrade. Its journal and snapshot are retained; restore them before another upgrade.');
   }
   if (check || to && ![journal.target?.commit, journal.target?.tag].includes(to) ||
     journalKey && journal.journalKey && journalKey !== journal.journalKey) {
    throw failure('refused', 'An interrupted upgrade must be verified with its original target or explicitly restored before another request.');
   }
  }
  const terminalResume = artifactOutcome(journal) === 'terminal' && journal.runtimeSettled === false && !restore &&
   current.branch === journal.branch && current.head === (journal.stage === 'complete' ? journal.prepared?.candidate : journal.head) &&
   (!to || [journal.target?.commit, journal.target?.tag].includes(to)) && (!journalKey || journalKey === journal.journalKey);
  operation = await acquireOperation(checkout, async custody => {
   wasRunning = protectedJournal ? journal.wasRunning : intendedRunning(intent ?? loaded, custody, await runningApp(checkout));
   if (!protectedJournal && !restore) await rememberIntent(checkout, current, wasRunning, custody);
  });
  if (!protectedJournal) { preserveJournal = false; journal.wasRunning = wasRunning; }
  // Discardable attempts protect runtime intent only. Settle it at today's HEAD
  // even when the owner committed or selected a different target after the crash.
  if (!protectedJournal && !restore) {
   // A borrowed server can still be exiting after its custodian died. Do not
   // mistake that transient registry entry for independently settled custody.
   if (operation.reclaimedIdentity) await stopApp(checkout, operation);
   if (wasRunning && !await runningApp(checkout)) await health(checkout, await startApp(checkout, operation));
  }
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
   await forgetIntent(checkout);
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
   if (!wasRunning) await stopApp(checkout, operation);
   const result = output(journal.stage === 'complete' ? 'updated' : 'rolled_back', journal, started,
    errorCodes.has(journal.result?.error_code) ? journal.result.error_code : undefined);
   journal.result = result; await forgetIntent(checkout); settleJournal = true;
   await phase(journal.stage === 'complete' ? 'ready' : 'failed', result.error_code);
   return result;
  }
  if (journalKey && journal.journalKey === journalKey && journal.result) {
   await forgetIntent(checkout);
   return journal.result;
  }
  if (journal.stage === 'verified') {
   if (current.head !== journal.prepared?.candidate || current.branch !== journal.branch || to && ![journal.target.commit, journal.target.tag].includes(to)) throw failure('refused');
   switched = true;
   await forgetIntent(checkout);
   if (journal.wasRunning) await health(checkout, (await runningApp(checkout))?.url ?? await startApp(checkout, operation));
   else await stopApp(checkout, operation);
   const result = output('updated', journal, started);
   journal.stage = 'complete'; journal.result = result; await writeJournal(checkout, journal); settleJournal = true;
   await cleanupMerge(checkout, journal.prepared); await phase('ready');
   return result;
  }
  if (protectedJournal || artifactOutcome(journal) === 'pre-switch') {
   const samePreparation = current.head === journal.head && current.branch === journal.branch && (!to || [journal.target?.commit, journal.target?.tag].includes(to));
   if (journal.prepared?.candidate && (current.head === journal.prepared.candidate || journal.stage === 'switch_pending' && current.head === journal.head) && ['switch_pending', 'switched', 'installed', 'started'].includes(journal.stage)) {
    switched = true;
    journal.custody = operation.identity; await writeJournal(checkout, journal);
    await forgetIntent(checkout);
    await stopApp(checkout, operation);
    await phase('get');
    const verified = await resolveRelease({ checkout, to: journal.target.commit, repository: journal.from.repository, anchors });
    if (verified.commit !== journal.target.commit) throw failure('release_unverified');
    await apply(checkout, journal, operation, phase, allowDataChange);
   } else if (journal.stage === 'needs_integration' && samePreparation && continuing) {
    await phase('get');
    journal.target = await resolveRelease({ checkout, to: journal.target.commit, repository: journal.from.repository, anchors });
    journal.prepared = await continueMerge({ checkout, ...journal.prepared });
    journal.stage = 'prepared';
   } else if (journal.stage === 'needs_integration' && samePreparation) {
    await phase('failed', 'needs_integration');
    return output('needs_integration', journal, started, 'needs_integration');
   } else { await discard(checkout, journal); journal = {}; preserveJournal = false; }
  } else journal = {}; // Leave settled history intact until a new verified preparation replaces it.
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
    journal = { version: 1, journalKey: journalKey ?? randomUUID(), checkout_name: basename(checkout), head: current.head, branch: current.branch, from, target, wasRunning, custody: operation.identity, runtimeSettled: false, stage: 'preparing' };
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
   journal.custody = operation.identity; journal.wasRunning = wasRunning; journal.runtimeSettled = false;
   await writeJournal(checkout, journal);
   await forgetIntent(checkout);
   await phase('install');
   if (check) { settleJournal = true; return output('refused', journal, started); }
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
  const code = errorCodes.has(error.error_code) ? error.error_code : 'refused';
  const busy = error.code === 'LOCAL_OPERATION_BUSY' || error.operationBusy;
  if (!switched && needsRecovery(journal) && !busy) onRecovery?.();
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
   await phase('failed', code);
   return output('refused', journal, started, code);
  }
  if ((journal.wasRunning ?? wasRunning) && operation) {
   try { if (!await runningApp(checkout)) await health(checkout, await startApp(checkout, operation)); }
   catch {
    onDiagnostic?.('The app could not be restarted. Its pre-switch runtime intent is retained; rerun rer upgrade to try again.');
    await phase('failed', 'start_failed'); return output('refused', journal, started, 'start_failed');
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
