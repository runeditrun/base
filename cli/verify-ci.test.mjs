import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { shouldSkipMainVerification, lookupMainVerification } from '../export/verify-ci.mjs';

// Public GitHub response recorded 2026-10-23, runeditrun/base Verify run
// 39915529209. Only fields consumed by the decision are retained. Cases below
// vary those response fields; the only fake is the HTTP edge.
const recorded = JSON.parse(await readFile(new URL('./tests/fixtures/verify-ci/workflow-runs.json', import.meta.url)));
const green = recorded.workflow_runs[0];
const currentRun = { ...green, id: green.id + 1, head_branch: 'main', event: 'push', status: 'in_progress', conclusion: null };
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: green.head_sha,
 GITHUB_REPOSITORY: green.repository.full_name, GITHUB_WORKFLOW: green.name,
 GITHUB_RUN_ID: String(currentRun.id), GITHUB_TOKEN: 'synthetic-ci-credential' };
const context = { eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha: env.GITHUB_SHA,
 repository: env.GITHUB_REPOSITORY, workflow: env.GITHUB_WORKFLOW, runId: env.GITHUB_RUN_ID, currentRun };
const list = runs => ({ total_count: runs.length, workflow_runs: runs });

test('main duplicate lookup authorizes only complete successful same-workflow branch evidence and fails open', async t => {
 const cases = [
  ['recorded green branch', recorded, true],
  ['green push', list([{ ...green, event: 'push' }]), true],
  ['green pull request', list([{ ...green, event: 'pull_request' }]), true],
  ['red, cancelled and in progress', list([
   { ...green, conclusion: 'failure' }, { ...green, conclusion: 'cancelled' },
   { ...green, status: 'in_progress', conclusion: null },
  ]), false],
  ['only main', list([{ ...green, head_branch: 'main' }]), false],
  ['different workflow name', list([{ ...green, name: 'Another workflow' }]), false],
  ['different workflow id', list([{ ...green, workflow_id: green.workflow_id + 1 }]), false],
  ['different repository', list([{ ...green, repository: { id: 1, full_name: 'synthetic/other' } }]), false],
  ['fork evidence', list([{ ...green, head_repository: { id: 1, full_name: 'synthetic/fork' } }]), false],
  ['other SHA', list([{ ...green, head_sha: '0'.repeat(40) }]), false],
  ['scheduled evidence', list([{ ...green, event: 'schedule' }]), false],
  ['no branch', list([{ ...green, head_branch: null }]), false],
  ['empty list', list([]), false],
  ['malformed body', { message: 'unavailable' }, false],
  ['malformed run next to green', list([green, {}]), false],
  ['incomplete page', { total_count: 2, workflow_runs: [green] }, false],
 ];
 for (const [label, body, expected] of cases) {
  assert.equal(shouldSkipMainVerification(body, context), expected, label);
  assert.equal(await lookupMainVerification({ env, fetch: async url => new Response(JSON.stringify(
   url.includes('/workflows/') ? body : currentRun), { status: 200 }) }), expected, `HTTP ${label}`);
 }
 for (const change of [
  { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
  { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_TOKEN: '' },
 ]) {
  assert.equal(await lookupMainVerification({ env: { ...env, ...change }, fetch: () => assert.fail('ineligible lookup must not call GitHub') }), false);
 }
 for (const status of [403, 429, 500]) for (const at of ['identity', 'list']) {
  assert.equal(await lookupMainVerification({ env, fetch: async url =>
   at === 'identity' || url.includes('/workflows/') ? new Response('{}', { status }) : new Response(JSON.stringify(currentRun)) }), false);
 }
 for (const fetch of [async () => { throw Error('network unavailable'); }, async () => new Response('not JSON')]) {
  assert.equal(await lookupMainVerification({ env, fetch }), false);
 }
 assert.equal(await lookupMainVerification({ env, fetch: async () => new Response('{}') }), false, 'malformed identity');
 const page1 = { total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, index) => ({ ...green, id: index + 1, conclusion: 'failure' })) };
 const page2 = { total_count: 101, workflow_runs: [green] };
 let pages = [];
 const paginated = async (second = page2, status = 200) => lookupMainVerification({ env, fetch: async url => {
  if (!url.includes('/workflows/')) return new Response(JSON.stringify(currentRun));
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('head_sha'), env.GITHUB_SHA, 'query is bound to the pushed SHA');
  const page = Number(parsed.searchParams.get('page'));
  pages.push(page);
  return new Response(JSON.stringify(page === 1 ? page1 : second), { status: page === 1 ? 200 : status });
 } });
 assert.equal(await paginated(), true, 'green run on page 2');
 assert.deepEqual(pages, [1, 2]);
 assert.equal(await paginated({}, 500), false, 'page 2 API failure');
 assert.equal(await paginated({ total_count: 101, workflow_runs: [{}] }), false, 'page 2 malformed');
 assert.equal(await paginated({ ...page2, total_count: 102 }), false, 'changing page count');

 // Use the command the workflow runs, including its actual GITHUB_OUTPUT write.
 const directory = await mkdtemp(join(tmpdir(), 'verify-ci-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const preload = join(directory, 'network.mjs'), output = join(directory, 'output');
 await writeFile(preload, `globalThis.fetch = async url => new Response(JSON.stringify(url.includes('/workflows/') ? ${JSON.stringify(recorded)} : ${JSON.stringify(currentRun)}));\n`);
 const command = spawnSync(process.execPath, ['--import', preload, 'export/verify-ci.mjs', '--main-skip'], {
  cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, ...env, GITHUB_OUTPUT: output },
 });
 assert.equal(command.status, 0, command.stderr);
 assert.equal(await readFile(output, 'utf8'), 'skip=true\n');
});
