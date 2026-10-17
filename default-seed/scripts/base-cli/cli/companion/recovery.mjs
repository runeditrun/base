import { lstat } from 'node:fs/promises';
import { git } from './workspace.mjs';
import { join } from 'node:path';
import { assertNoTurnEvidence } from './no-turn-evidence.mjs';

export function canRestartPreparation(active) {
  return active?.status==='needs_reconciliation' && ['workspace_preparation_failed','pre_executor_failed'].includes(active.phase)
    && active.executorStarted===false && !active.identity && (!active.workspace || active.phase==='pre_executor_failed');
}

// This is an explicit operator attestation, never an inference during startup.
// The CLI holds runner.lock while checking and saving this legacy-state upgrade.
export async function confirmUnstarted(root,state,jobId,confirmed) {
  const active=state.active;
  if(!confirmed)throw new Error('Supply --confirm-no-executor-started only after verifying the preparation failure occurred before provider startup.');
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId||'') || active?.job?.id!==jobId || active.status!=='needs_reconciliation'
    || active.identity || active.workspace || active.phase || active.executorStarted!==undefined || state.pendingControl)
    throw new Error('Only an exact legacy preparation failure without executor or pending-control state can be attested.');
  let workspace;
  try {
    const worktree=join(root,'worktrees',jobId);await lstat(worktree);
    const mapping=state.mappings[active.job.project_id];
    if(!mapping || mapping.repository!==active.job.repository || !/^[a-f0-9]{40}$/.test(active.job.base_commit||''))throw new Error('Retained worktree cannot be verified against approved mapping.');
    if(await git(mapping.checkout,'remote','get-url','origin')!==mapping.remote || await git(worktree,'remote','get-url','origin')!==mapping.remote
      || await git(worktree,'rev-parse','HEAD')!==active.job.base_commit || await git(worktree,'status','--porcelain','--untracked-files=all','--ignored'))throw new Error('Retained worktree differs from clean approved base; recovery refused.');
    workspace={worktree,baseCommit:active.job.base_commit};
  }
  catch(error){if(error.code!=='ENOENT')throw error;}
  active.phase=workspace?'pre_executor_failed':'workspace_preparation_failed';active.executorStarted=false;
  if(workspace)active.workspace=workspace;
  active.recoveryAttestation={kind:'operator_confirmed_no_executor',at:new Date().toISOString(),jobId};
}

// The operator must separately verify all provider/setup children have exited.
// A missing identity alone is never evidence that no turn was started.
export async function confirmNoTurnStarted(root,state,jobId,confirmed) {
  const active=state.active;
  if(!confirmed)throw new Error('Supply --confirm-no-provider-turn-started only after verifying setup failed before session.open and all provider/setup children exited.');
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId||'') || active?.job?.id!==jobId || active.status!=='needs_reconciliation'
    || !['executor_starting','setup_failed'].includes(active.phase) || active.executorStarted!==true
    || active.identity || state.pendingControl)
    throw new Error('Only an exact failed setup without session identity or pending controls can be attested.');
  const worktree=join(root,'worktrees',jobId),mapping=state.mappings[active.job.project_id];
  if(active.workspace?.worktree!==worktree || active.workspace?.baseCommit!==active.job.base_commit
    || !mapping || mapping.repository!==active.job.repository || !/^[a-f0-9]{40}$/.test(active.job.base_commit||''))
    throw new Error('Retained worktree cannot be verified against approved mapping.');
  const info=await lstat(worktree);
  if(!info.isDirectory() || info.isSymbolicLink())throw new Error('Retained worktree must be an ordinary directory.');
  if(await git(mapping.checkout,'remote','get-url','origin')!==mapping.remote || await git(worktree,'remote','get-url','origin')!==mapping.remote
    || await git(worktree,'rev-parse','HEAD')!==active.job.base_commit || await git(worktree,'status','--porcelain','--untracked-files=all'))
    throw new Error('Retained worktree differs from clean approved source; recovery refused.');
  const ignored=await git(worktree,'ls-files','--others','--ignored','--exclude-standard','-z');
  if(ignored.split('\0').filter(Boolean).some(path=>!path.startsWith('node_modules/'))) throw new Error('Ignored files outside installed node_modules prevent no-turn attestation.');
  await assertNoTurnEvidence(root,state);
  const previousState=structuredClone(active);
  active.phase='pre_executor_failed';active.executorStarted=false;
  active.recoveryAttestation={kind:'operator_confirmed_no_provider_turn',at:new Date().toISOString(),jobId,previousState};
}
