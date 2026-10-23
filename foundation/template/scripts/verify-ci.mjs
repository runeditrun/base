import { appendFile } from 'node:fs/promises';

const candidateEvents = new Set(['push', 'pull_request', 'workflow_dispatch']);
const repositoryShape = value => Number.isSafeInteger(value?.id) && value.id > 0 && typeof value.full_name === 'string';
const runShape = value => value && Number.isSafeInteger(value.id) && value.id > 0
 && Number.isSafeInteger(value.workflow_id) && value.workflow_id > 0
 && typeof value.name === 'string' && /^[a-f0-9]{40}$/.test(value.head_sha ?? '')
 && (typeof value.head_branch === 'string' || value.head_branch === null)
 && typeof value.event === 'string' && typeof value.status === 'string'
 && (typeof value.conclusion === 'string' || value.conclusion === null)
 && repositoryShape(value.repository) && (value.head_repository === null || repositoryShape(value.head_repository));

// Only complete, valid API evidence can authorize skipping the main duplicate.
export function shouldSkipMainVerification(response, { eventName, ref, sha, repository, workflow, runId, currentRun } = {}) {
 if (eventName !== 'push' || ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(sha ?? '')
  || !runShape(currentRun) || String(currentRun.id) !== runId || currentRun.head_sha !== sha
  || currentRun.repository.full_name !== repository || currentRun.name !== workflow
  || currentRun.event !== 'push' || currentRun.head_branch !== 'main'
  || !Number.isSafeInteger(response?.total_count) || response.total_count < 0
  || !Array.isArray(response.workflow_runs) || response.total_count !== response.workflow_runs.length
  || !response.workflow_runs.every(runShape)) return false;
 return response.workflow_runs.some(run => run.id !== currentRun.id
  && run.workflow_id === currentRun.workflow_id && run.name === workflow
  && run.repository.id === currentRun.repository.id && run.repository.full_name === repository
  && run.head_repository?.id === currentRun.repository.id && run.head_repository.full_name === repository
  && run.head_sha === sha && run.head_branch && run.head_branch !== 'main'
  && candidateEvents.has(run.event) && run.status === 'completed' && run.conclusion === 'success');
}

export async function lookupMainVerification({ env = process.env, fetch = globalThis.fetch } = {}) {
 if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') return false;
 try {
  if (!/^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')
   || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !env.GITHUB_TOKEN) return false;
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const base = `${api}/repos/${env.GITHUB_REPOSITORY}/actions`;
  const signal = AbortSignal.timeout(20000);
  const get = async url => {
   const response = await fetch(url, { signal, redirect: 'error', headers: {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
   } });
   if (response.status !== 200) throw Error('GitHub run lookup unavailable');
   return response.json();
  };
  const currentRun = await get(`${base}/runs/${env.GITHUB_RUN_ID}`);
  if (!runShape(currentRun)) return false;
  const context = { eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha: env.GITHUB_SHA,
   repository: env.GITHUB_REPOSITORY, workflow: env.GITHUB_WORKFLOW, runId: env.GITHUB_RUN_ID, currentRun };
  const workflow_runs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
   const response = await get(`${base}/workflows/${currentRun.workflow_id}/runs?head_sha=${env.GITHUB_SHA}&per_page=100&page=${page}`);
   if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 || response.total_count > 1000
    || !Array.isArray(response.workflow_runs) || !response.workflow_runs.every(runShape)
    || (total !== undefined && total !== response.total_count)) return false;
   total = response.total_count;
   const expected = Math.min(100, total - workflow_runs.length);
   if (response.workflow_runs.length !== expected) return false;
   workflow_runs.push(...response.workflow_runs);
   if (workflow_runs.length === total) return shouldSkipMainVerification({ total_count: total, workflow_runs }, context);
  }
 } catch {
  // Authentication, rate limits, network/JSON failures and timeouts all run CI.
 }
 return false;
}

if (process.argv[1] === import.meta.filename) {
 const [mode, tier] = process.argv.slice(2);
 if (mode === '--main-skip' && !tier) {
  const output = `skip=${await lookupMainVerification()}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
 } else {
  const { verificationPlan, run } = await import('./verify-app.mjs');
  const plan = await verificationPlan();
  if (mode === '--matrix') {
   if (!['push', 'all'].includes(tier)) throw Error('Usage: verify-ci.mjs --matrix push|all');
   const shards = tier === 'push' ? plan.push : [...plan.push, ...plan.nightly];
   console.log(JSON.stringify({ include: shards.map(({ name, browser }) => ({ name, browser })) }));
  } else {
   const shard = [...plan.push, ...plan.nightly].find(shard => shard.name === mode);
   if (!shard || tier) throw Error('Usage: verify-ci.mjs SHARD');
   // Exactly one job retains rer verify's hosted-output and hydration checks.
   run(shard.hosted ? 'pnpm run verify' : 'pnpm run verify:app', { ...process.env, SEED_VERIFY_SHARD: shard.name });
  }
 }
}
