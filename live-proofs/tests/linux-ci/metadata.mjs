import assert from 'node:assert/strict';
export function ciMetadata(env, event, sourceCommit) {
  const pr = event.pull_request;
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.GITHUB_EVENT_NAME, 'pull_request');
  assert.equal(env.GITHUB_REPOSITORY, 'runeditrun/base'); assert.equal(event.repository?.full_name, 'runeditrun/base');
  assert.equal(event.repository?.private, true); assert.equal(pr?.head?.repo?.full_name, 'runeditrun/base');
  assert.equal(pr.head.repo.private, true); assert.equal(pr.base.repo.full_name, 'runeditrun/base'); assert.equal(pr.base.repo.private, true);
  assert.match(pr.head.sha, /^[a-f0-9]{40}$/); assert.equal(pr.head.sha, sourceCommit);
  assert.match(env.GITHUB_WORKFLOW_SHA ?? '', /^[a-f0-9]{40}$/);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', /^[1-9][0-9]*$/);
  assert.equal(env.GITHUB_SERVER_URL, 'https://github.com'); assert.match(env.GITHUB_JOB ?? '', /^[A-Za-z0-9_-]+$/);
  return { repository: env.GITHUB_REPOSITORY, private: true, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    job: env.GITHUB_JOB, headSha: sourceCommit, workflowSha: env.GITHUB_WORKFLOW_SHA, mergeSha: env.GITHUB_SHA,
    prNumber: pr.number, runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` };
}
