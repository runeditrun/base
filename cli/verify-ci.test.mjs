import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lookupMainVerification } from '../export/verify-ci.mjs';

const helper = resolve(import.meta.dirname, '../export/verify-ci.mjs');
// Public GitHub responses recorded 2026-10-23: runeditrun/base Verify run
// 39821100223 (the rer-v0.2.79 tag push) and its jobs. Only fields consumed by
// the decision are retained. Cases below vary those response fields; the only
// fake is the HTTP edge.
const fixture = async name => JSON.parse(await readFile(new URL(`./tests/fixtures/verify-ci/${name}`, import.meta.url)));
const recorded = await fixture('workflow-runs.json'), recordedJobs = await fixture('workflow-jobs.json');
const green = recorded.workflow_runs[0];
const currentRun = { ...green, id: green.id + 1000, head_branch: 'main', event: 'push', status: 'in_progress', conclusion: null };
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: green.head_sha,
 GITHUB_REPOSITORY: green.repository.full_name, GITHUB_WORKFLOW: green.name, GITHUB_JOB: 'plan',
 GITHUB_RUN_ID: String(currentRun.id), GITHUB_TOKEN: 'synthetic-ci-credential' };
const list = runs => ({ total_count: runs.length, workflow_runs: runs });
const jobsOf = (runId, jobs = recordedJobs.jobs) => ({ total_count: jobs.length, jobs: jobs.map(job => ({ ...job, run_id: runId })) });
const skipped = (name, id) => ({ id, name, status: 'completed', conclusion: 'skipped' });
// GitHub's run, list-runs and list-jobs endpoints, answered from these bodies.
const github = (runs, { jobs = jobsOf, mainJobs = jobsOf(currentRun.id, []) } = {}) => async url => {
 const path = new URL(url).pathname, run = /\/runs\/(\d+)\/jobs$/.exec(path)?.[1];
 return new Response(JSON.stringify(path.includes('/workflows/') ? runs
  : run === String(currentRun.id) ? mainJobs : run ? jobs(Number(run)) : currentRun));
};

test('main duplicate lookup authorizes only the newest complete green push of the SHA elsewhere and fails open', async t => {
 const push = { ...green, head_branch: 'cloud/candidate' };
 const newer = (fields, by = 1) => ({ ...push, id: push.id + by, ...fields });
 const cases = [
  ['recorded tag push', recorded, true],
  ['candidate branch push', list([push]), true],
  ['dispatch, which may run a subset', list([{ ...push, event: 'workflow_dispatch' }]), false],
  ['pull request, which tests a merge ref', list([{ ...push, event: 'pull_request' }]), false],
  ['red, cancelled and in progress', list([{ ...push, conclusion: 'failure' },
   newer({ conclusion: 'cancelled' }), newer({ status: 'in_progress', conclusion: null }, 2)]), false],
  ['newest push red over an older green one', list([newer({ conclusion: 'failure' }), push]), false],
  ['newer dispatch cancelled after the green push', list([newer({ event: 'workflow_dispatch', conclusion: 'cancelled' }), push]), false],
  ['newer pull request still running', list([newer({ event: 'pull_request', status: 'in_progress', conclusion: null }), push]), false],
  ['newer green pull request', list([newer({ event: 'pull_request' }), push]), true],
  ['older red dispatch', list([push, newer({ event: 'workflow_dispatch', conclusion: 'failure' }, -1)]), true],
  ['only main', list([{ ...push, head_branch: 'main' }]), false],
  ['different workflow name', list([{ ...push, name: 'Another workflow' }]), false],
  ['different workflow id', list([{ ...push, workflow_id: push.workflow_id + 1 }]), false],
  ['different repository', list([{ ...push, repository: { id: 1, full_name: 'synthetic/other' } }]), false],
  ['fork evidence', list([{ ...push, head_repository: { id: 1, full_name: 'synthetic/fork' } }]), false],
  ['other SHA', list([{ ...push, head_sha: '0'.repeat(40) }]), false],
  ['scheduled evidence', list([{ ...push, event: 'schedule' }]), false],
  ['no branch', list([{ ...push, head_branch: null }]), false],
  ['empty list', list([]), false],
  ['malformed body', { message: 'unavailable' }, false],
  ['malformed run next to green', list([push, {}]), false],
  ['incomplete page', { total_count: 2, workflow_runs: [push] }, false],
  ['one run listed twice', list([push, push]), false],
  // A green run proves nothing for jobs it skipped, such as a job downstream of
  // a skipped gate, unless main skips that job too.
  ['evidence skipped a job', list([push]), false, { jobs: id => jobsOf(id, [...recordedJobs.jobs, skipped('contract', 1)]) }],
  ['evidence job failed in a green run', list([push]), false,
   { jobs: id => jobsOf(id, recordedJobs.jobs.map((job, index) => index ? job : { ...job, conclusion: 'failure' })) }],
  ['evidence skipped only this main-only gate', list([push]), true,
   { env: { GITHUB_JOB: 'main-verify' }, jobs: id => jobsOf(id, [...recordedJobs.jobs, skipped('main-verify', 1)]) }],
  ['evidence skipped a job this main run skipped', list([push]), true,
   { jobs: id => jobsOf(id, [...recordedJobs.jobs, skipped('journeys', 1)]), mainJobs: jobsOf(currentRun.id, [skipped('journeys', 2)]) }],
  ['jobs of another run', list([push]), false, { jobs: () => jobsOf(1) }],
  ['no jobs', list([push]), false, { jobs: id => jobsOf(id, []) }],
 ];
 for (const [label, body, expected, { env: change, ...answers } = {}] of cases) {
  assert.equal(await lookupMainVerification({ env: { ...env, ...change }, fetch: github(body, answers) }), expected, label);
 }
 for (const change of [
  { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
  { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_TOKEN: '' },
 ]) {
  assert.equal(await lookupMainVerification({ env: { ...env, ...change }, fetch: () => assert.fail('ineligible lookup must not call GitHub') }), false);
 }
 for (const status of [403, 429, 500]) for (const at of ['/runs/', '/workflows/', '/jobs']) {
  const answer = github(list([push]));
  assert.equal(await lookupMainVerification({ env, fetch: async url => {
   const path = new URL(url).pathname;
   const endpoint = path.includes('/workflows/') ? '/workflows/' : path.endsWith('/jobs') ? '/jobs' : '/runs/';
   return endpoint === at ? new Response('{}', { status }) : answer(url);
  } }), false, `${status} from ${at}`);
 }
 for (const fetch of [async () => { throw Error('network unavailable'); }, async () => new Response('not JSON')]) {
  assert.equal(await lookupMainVerification({ env, fetch }), false);
 }
 assert.equal(await lookupMainVerification({ env, fetch: async () => new Response('{}') }), false, 'malformed identity');
 // Which run is newest decides, wherever GitHub lists it.
 const failures = from => Array.from({ length: 100 }, (_, index) => ({ ...push, id: push.id + from + index, conclusion: 'failure' }));
 const pages = [];
 const paginated = (first, second = { total_count: 101, workflow_runs: [push] }, status = 200) => {
  const answer = github(list([]));
  return lookupMainVerification({ env, fetch: async url => {
   const parsed = new URL(url);
   if (!parsed.pathname.includes('/workflows/')) return answer(url);
   assert.equal(parsed.searchParams.get('head_sha'), env.GITHUB_SHA, 'query is bound to the pushed SHA');
   const page = Number(parsed.searchParams.get('page'));
   pages.push(page);
   return new Response(JSON.stringify(page === 1 ? { total_count: 101, workflow_runs: first } : second), { status: page === 1 ? 200 : status });
  } });
 };
 assert.equal(await paginated(failures(1)), false, '100 newer failures on page 1 outweigh the green push on page 2');
 assert.deepEqual(pages, [1, 2]);
 assert.equal(await paginated(failures(-100)), true, 'the green push on page 2 is the newest run');
 assert.equal(await paginated(failures(-100), {}, 500), false, 'page 2 API failure');
 assert.equal(await paginated(failures(-100), { total_count: 101, workflow_runs: [{}] }), false, 'page 2 malformed');
 assert.equal(await paginated(failures(-100), { total_count: 102, workflow_runs: [push] }), false, 'changing page count');

 // The command the workflow runs, invoked through a symlinked path, with its
 // actual GITHUB_OUTPUT write.
 const directory = await mkdtemp(join(tmpdir(), 'verify-ci-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const preload = join(directory, 'network.mjs'), output = join(directory, 'output'), linked = join(directory, 'verify-ci.mjs');
 await symlink(helper, linked);
 await writeFile(preload, `const runs = ${JSON.stringify(recorded)}, jobs = ${JSON.stringify(recordedJobs)}, current = ${JSON.stringify(currentRun)};
globalThis.fetch = async url => new Response(JSON.stringify(url.includes('/workflows/') ? runs : url.includes('/jobs') ? jobs : current));\n`);
 const command = spawnSync(process.execPath, ['--import', preload, linked, '--main-skip'], {
  cwd: directory, encoding: 'utf8', env: { ...process.env, ...env, GITHUB_OUTPUT: output },
 });
 assert.equal(command.status, 0, command.stderr);
 assert.equal(await readFile(output, 'utf8'), 'skip=true\n');
});

test('a workflow calling Verify must grant every token permission its jobs request', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'verify-callers-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const workflows = join(directory, '.github/workflows');
 await mkdir(workflows, { recursive: true });
 await copyFile(resolve(import.meta.dirname, '../export/verify.yml'), join(workflows, 'verify.yml'));
 const caller = (workflow, job = '') => `name: Nightly journeys\non:\n  schedule:\n    - cron: '23 3 * * *'\n${workflow}jobs:\n  verify:\n${job}    uses: ./.github/workflows/verify.yml\n    with:\n      tier: all\n`;
 for (const [label, nightly, refusal] of [
  ['exported caller', await readFile(resolve(import.meta.dirname, '../export/verify-nightly.yml'), 'utf8')],
  ['caller granting contents only', caller('permissions:\n  contents: read\n'), /verify-nightly\.yml job verify .*actions: none.*verify\.yml job plan .*actions: read/],
  ['flow mapping on the calling job', caller('permissions:\n  contents: read\n', '    permissions: { contents: read, actions: read }\n')],
  ['read-all workflow grant', caller('permissions: read-all\n')],
  ['repository default token', caller(''), /verify-nightly\.yml job verify/],
 ]) {
  await writeFile(join(workflows, 'verify-nightly.yml'), nightly);
  const result = spawnSync(process.execPath, [helper, '--check-workflows'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, refusal ? 1 : 0, `${label}: ${result.stderr}`);
  if (refusal) assert.match(result.stderr, refusal, label);
 }
});
