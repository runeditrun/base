import { proofs, repository, requireProof, requireSha } from './policy.mjs';
import { stage } from './stage-adapter.mjs';
import { validateQualification } from './t016/observations.mjs';
const statuses = new Set(['passed', 'missing-secret', 'proof-failed', 'deploy-failed',
  'health-failed', 'stage-target-unconfigured', 'execution-failed']);
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value));
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
export function makeReceipt(env, now = new Date().toISOString()) {
  const sha = requireSha(env.VALIDATED_SHA);
  const controlSha = requireSha(env.CONTROL_SHA);
  if (env.GITHUB_REPOSITORY !== repository || !id(env.GITHUB_RUN_ID) || !id(env.GITHUB_RUN_ATTEMPT))
    throw new Error('invalid-run-metadata');
  const mode = env.MODE;
  if (mode !== 'proof' && mode !== 'stage') throw new Error('invalid-mode');
  const proof = mode === 'proof' ? requireProof(env.INPUT_PROOF) : null;
  if (!['success', 'failure', 'cancelled', 'skipped'].includes(env.JOB_RESULT)) throw new Error('invalid-job-result');
  let status = env.EXECUTION_RESULT || 'execution-failed';
  if (!statuses.has(status)) throw new Error('invalid-result');
  const executed = env.EXECUTED_SHA === sha;
  if (env.EXECUTED_SHA && !executed) throw new Error('invalid-executed-sha');
  if (status === 'passed' && (env.JOB_RESULT !== 'success' || !executed)) status = 'execution-failed';
  if (mode === 'proof' && ['deploy-failed', 'health-failed', 'stage-target-unconfigured'].includes(status))
    throw new Error('invalid-result');
  if (mode === 'stage' && (status === 'proof-failed' || (stage.blocked && status === 'passed')))
    throw new Error('invalid-result');
  for (const value of [env.STARTED, env.FINISHED]) if (value && !utc(value)) throw new Error('invalid-time');
  const t016 = proof?.startsWith('t016-');
  let qualification = null;
  if (env.QUALIFICATION) {
    if (!t016 || env.QUALIFICATION.length > 60000) throw new Error('invalid-qualification');
    qualification = validateQualification(JSON.parse(env.QUALIFICATION), proof);
    if (qualification.observations.some(item => item.phase === 'isolation' && item.facts.controllerSha !== controlSha))
      throw new Error('invalid-isolation-controller');
    if (qualification.result === 'failed' && status === 'passed') status = 'proof-failed';
  }
  if (t016 && status === 'passed' && (!qualification || qualification.result !== 'passed')) status = 'execution-failed';
  const commands = [];
  if (executed && t016 && qualification) commands.push(proof === 't016-r2-on'
    ? ['node', 'scripts/qualify-standalone.mjs', '--seed', 'happytohelp'] : proofs[proof]);
  // qualification.commands additionally records the actual public Git, install,
  // build, setup and deploy commands across the execution boundaries.
  if (executed && mode === 'proof' && !t016 && ['passed', 'proof-failed'].includes(status)) commands.push(proofs[proof]);
  if (executed && mode === 'stage' && !stage.blocked) {
    if (['passed', 'deploy-failed', 'health-failed'].includes(status)) commands.push(stage.deploy);
    if (['passed', 'health-failed'].includes(status)) commands.push(stage.health);
  }
  return { version: 1, repository, workflow: mode === 'proof' ? 'live-proof' : 'deploy-stage',
    proof, sha, executedSha: executed ? sha : null, controlSha,
    command: ['node', 'control/live-proofs/run.mjs'], commands,
    startedUtc: env.STARTED || null, finishedUtc: env.FINISHED || null, recordedUtc: now,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    result: status === 'passed' ? 'passed' : 'failed', failureStatus: status === 'passed' ? null : status,
    jobResult: env.JOB_RESULT, ...(t016 ? { qualification } : {}) };
}
// Only our constructor's exact schema is accepted. This blocks arbitrary uploaded
// files, paths, command strings, extra fields and unsanitized error payloads.
export function validateReceipt(receipt) {
  const reconstructed = makeReceipt({ VALIDATED_SHA: receipt.sha, CONTROL_SHA: receipt.controlSha,
    GITHUB_REPOSITORY: receipt.repository, GITHUB_RUN_ID: receipt.runId,
    GITHUB_RUN_ATTEMPT: receipt.runAttempt, MODE: receipt.workflow === 'live-proof' ? 'proof' : 'stage',
    INPUT_PROOF: receipt.proof, JOB_RESULT: receipt.jobResult, EXECUTION_RESULT: receipt.failureStatus || receipt.result,
    EXECUTED_SHA: receipt.executedSha || '', STARTED: receipt.startedUtc || '', FINISHED: receipt.finishedUtc || '',
    QUALIFICATION: receipt.qualification ? JSON.stringify(receipt.qualification) : '',
  }, receipt.recordedUtc);
  if (!utc(receipt.recordedUtc) || JSON.stringify(receipt) !== JSON.stringify(reconstructed))
    throw new Error('invalid-receipt-schema');
  return receipt;
}
