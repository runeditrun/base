import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lookupMainVerification } from '../export/verify-ci.mjs';

const helper = resolve(import.meta.dirname, '../export/verify-ci.mjs');

test('Base and delivered workflow templates parse with their local reusable workflows', async t => {
 const { ciPlan, groups } = await import('../scripts/ci/verify.mjs');
 const { MODULE_SHARDS, moduleShardPlan, moduleTestFiles } = await import('../scripts/ci/module-shard.mjs');
 const { CLI_SHARDS, cliShardPlan, cliTestFiles } = await import('../scripts/ci/cli-shard.mjs');
 const matrix = await ciPlan();
 assert.equal(matrix.include.length, 8, 'retain the eight-job Linux cap');
 assert.equal(Object.keys(await moduleShardPlan()).length, MODULE_SHARDS);
 assert.equal(Object.keys(await cliShardPlan()).length, CLI_SHARDS);
 assert.deepEqual(Object.values(await moduleShardPlan()).flat().sort(), await moduleTestFiles());
 assert.deepEqual(Object.values(await cliShardPlan()).flat().sort(), await cliTestFiles());
 for (const { group, native } of matrix.include) {
  assert.equal(native, groups[group].some(task => task.stage === 'verify:editor'), 'native setup must follow the editor stage');
 }
 const nightly = await ciPlan({ journeys: true });
 assert.deepEqual(nightly.include.slice(0, -1), matrix.include);
 assert.equal(nightly.include.at(-1).group, 'journeys', 'retain the scheduled journeys');
 const root = resolve(import.meta.dirname, '..');
 const temporary = await mkdtemp(join(tmpdir(), 'rer-workflow-lint-'));
 t.after(() => rm(temporary, { recursive: true, force: true }));
 for (const [index, source] of ['.github/workflows', 'export', 'default-seed/.github/workflows', 'foundation/template/.github/workflows'].entries()) {
  let entries;
  try { entries = await readdir(join(root, source)); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const files = entries.filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length, `${source}: expected workflows`);
  const project = join(temporary, String(index)), workflows = join(project, '.github/workflows');
  await mkdir(workflows, { recursive: true });
  const initialized = spawnSync('git', ['init', '--quiet', project], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  for (const name of files) await copyFile(join(root, source, name), join(workflows, name));
  // Shell/Python lint are separate tools. Keep this check portable and focused
  // on Actions YAML, expressions, contexts and reusable-workflow contracts.
  const result = spawnSync('actionlint', ['-shellcheck=', '-pyflakes=', ...files.map(name => join(workflows, name))], { cwd: project, encoding: 'utf8' });
  assert.equal(result.status, 0, `${source}: ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}\nInstall with bash scripts/install-actionlint.sh and add its directory to PATH.`);
  if (source === 'export') for (const name of files) {
   const text = await readFile(join(workflows, name), 'utf8');
   for (const block of text.matchAll(/^([ \t]*)path:\s*\|\s*\n((?:\1[ \t]+[^\n]*\n)+)/gm)) {
    for (const entry of block[2].trim().split('\n').map(line => line.trim())) {
     const expanded = entry.replaceAll('${{ runner.temp }}', join(project, 'runner-temp')).replace(/^~(?=\/)/, project).replaceAll('$HOME', project).replaceAll('${HOME}', project);
     assert.equal(expanded === project || expanded.startsWith(project + '/') && !expanded.startsWith(join(project, 'runner-temp') + '/'), false, `${source}/${name}: cache must stay outside HOME: ${entry}`);
    }
   }
  }
 }
 // Exercise the ordered file runner with module-level effects: no new test
 // registrations. Keep selected entries, order and a failing command's exit.
 const log = join(temporary, 'selected.log');
 const selected = [join(temporary, 'z-pass.mjs'), join(temporary, 'a-fail.mjs')];
 const unselected = join(temporary, 'unselected.mjs');
 for (const [index, file] of [...selected, unselected].entries()) {
  await writeFile(file, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, '${index}\\n'); ${index === 1 ? "throw Error('selected failure');" : ''}\n`);
 }
 const runnerEnv = { ...process.env }; delete runnerEnv.NODE_TEST_CONTEXT;
 const ordered = spawnSync(process.execPath, [join(root, 'scripts/ci/run-files.mjs'), '1', ...selected], { encoding: 'utf8', env: runnerEnv });
 assert.equal(ordered.status, 1, ordered.stdout + ordered.stderr);
 assert.equal(await readFile(log, 'utf8'), '0\n1\n', 'keep the selected files and their order');
 const passed = spawnSync(process.execPath, [join(root, 'scripts/ci/run-files.mjs'), '2', selected[0]], { encoding: 'utf8', env: runnerEnv });
 assert.equal(passed.status, 0, passed.stdout + passed.stderr);

});
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

test('verification planning requires the newest push proof, identical trees and complete reviewed coverage', async t => {
 const { planVerification } = await import('../export/verify-plan.mjs');
 const { renderVerifySchedule } = await import('../foundation/verify-schedule.mjs');
 const fixture = JSON.parse(await readFile(new URL('./tests/fixtures/verify-ci/planning.json', import.meta.url)));
 const directory = await mkdtemp(join(tmpdir(), 'synthetic-base-1-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const git = (...args) => {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
 };
 git('init', '--quiet');
 git('config', 'user.name', 'synthetic-base-1'); git('config', 'user.email', 'synthetic-base-1@example.com');
 const commit = async (file, contents) => {
  await mkdir(join(directory, file, '..'), { recursive: true });
  await writeFile(join(directory, file), contents); git('add', '.'); git('commit', '--quiet', '-m', 'synthetic-base-1');
  return git('rev-parse', 'HEAD');
 };
 await commit('src/base/contract-docs.mjs', 'export {};\n');
 await commit('scripts/edition-authoring/cli.mjs', 'export {};\n');
 await commit('tests/e2e/reference-runtime.mjs', 'export {};\n');
 await commit('edition.json', '{}\n');
 const parent = await commit('sources.lock.json', '{}\n');
 const head = await commit('STATUS.md', 'synthetic-base-1\n');
 const tree = sha => git('rev-parse', `${sha}^{tree}`);
 const commitBody = sha => ({ sha, commit: { tree: { sha: tree(sha) } }, parents: git('rev-list', '--parents', '-1', sha).split(' ').slice(1).map(sha => ({ sha })) });
 const current = { ...green, id: 5000, workflow_id: 41, run_attempt: 1, repository: fixture.repository,
  head_repository: fixture.repository, head_sha: head, head_branch: 'synthetic-base-3', event: 'push', status: 'in_progress', conclusion: null };
 const producer = { ...current, id: 4000, head_branch: 'synthetic-base-4', status: 'completed', conclusion: 'success' };
 const environment = { ...env, GITHUB_REPOSITORY: fixture.repository.full_name, GITHUB_RUN_ID: String(current.id),
  GITHUB_SHA: head, GITHUB_REF: `refs/heads/${current.head_branch}`, GITHUB_WORKFLOW: current.name, GITHUB_TOKEN: 'synthetic-base-5' };
 const plan = { push: fixture.push, nightly: [] };
 const proofJobs = (run, names = ['plan', 'full-push-proof', 'verify', ...plan.push.map(shard => `shards (${shard.name})`)]) => ({
  total_count: names.length, jobs: names.map((name, index) => ({ id: index + 1, run_id: run.id, run_attempt: run.run_attempt, name, status: 'completed', conclusion: 'success' })),
 });
 const network = ({ runs = [producer], self = current, commits = {}, jobs = proofJobs, latest = {}, listing } = {}) => async url => {
  const parsed = new URL(url), path = parsed.pathname;
  const runId = Number(/\/runs\/(\d+)/.exec(path)?.[1]);
  let answer;
  if (path.includes('/workflows/')) {
   const matches = runs.filter(run => run.head_sha === parsed.searchParams.get('head_sha'));
   answer = listing ? listing(matches, parsed) : list(matches);
  } else if (path.endsWith('/jobs')) {
   const run = runs.find(run => run.id === runId);
   assert.equal(Number(/\/attempts\/(\d+)/.exec(path)?.[1]), (latest[runId] ?? run).run_attempt);
   answer = jobs(latest[runId] ?? run);
  } else if (path.includes('/runs/')) answer = runId === self.id ? self : latest[runId] ?? runs.find(run => run.id === runId);
  else if (path.includes('/commits/')) {
   const sha = path.split('/').at(-1);
   answer = commits[sha] ?? commitBody(sha);
  } else assert.fail(`Unexpected endpoint: ${path}`);
  return new Response(JSON.stringify(answer));
 };
 const decide = options => planVerification({ cwd: directory, env: environment, plan, fetch: network(options) });
 assert.equal((await decide()).coverage, 'reuse', 'exact SHA full push proof');
 for (const change of [
  { event: 'pull_request' }, { event: 'workflow_dispatch' }, { event: 'schedule' },
  { workflow_id: 99 }, { repository: { id: 44, full_name: 'synthetic-base-6/synthetic-base-7' } },
  { head_repository: { id: 44, full_name: 'synthetic-base-6/synthetic-base-7' } },
 ]) assert.equal((await decide({ runs: [{ ...producer, ...change }] })).coverage, 'full', JSON.stringify(change));
 assert.equal((await decide({ runs: [producer, { ...producer, id: 4001, conclusion: 'failure' }] })).coverage, 'full', 'newest failure defeats old green');
 assert.equal((await decide({ latest: { [producer.id]: { ...producer, run_attempt: 2, conclusion: 'failure' } } })).coverage, 'full', 'latest attempt supersedes listing');
 assert.equal((await decide({ jobs: run => proofJobs(run, ['plan', 'verify']) })).coverage, 'full', 'green aggregate without full proof');
 assert.equal((await decide({ jobs: run => { const body = proofJobs(run); body.jobs[1].conclusion = 'skipped'; return body; } })).coverage, 'full', 'skipped proof');
 assert.equal((await decide({ runs: [producer, { ...producer, event: 'pull_request', id: 4001, conclusion: 'failure' }] })).coverage, 'reuse', 'ineligible newer PR does not replace eligible push');
 const parentRun = { ...producer, head_sha: parent };
 const light = await decide({ runs: [parentRun] });
 assert.equal(light.coverage, 'light', 'document change on verified parent');
 assert.ok(light.readers.length, 'changed documents retain their executable consistency reader');
 assert.equal((await decide({ runs: [parentRun], commits: { [head]: { ...commitBody(head), parents: [{ sha: parent }, { sha: parent }] } } })).coverage, 'full', 'ambiguous merge cannot select light');
 assert.equal((await decide({ runs: [] })).coverage, 'full', 'unverified parent');
 const changedReaders = { push: [{ ...plan.push[0], commands: ['node --test tests/synthetic-base-8.test.mjs'] }, plan.push[1]], nightly: [] };
 assert.equal((await planVerification({ cwd: directory, env: environment, plan: changedReaders, fetch: network({ runs: [parentRun] }) })).coverage, 'full', 'unknown reader refuses light');
 git('commit', '--allow-empty', '--quiet', '-m', 'synthetic-base-2');
 const child = git('rev-parse', 'HEAD'), childSelf = { ...current, head_sha: child };
 const childDecision = await planVerification({ cwd: directory, env: { ...environment, GITHUB_SHA: child }, plan,
  fetch: network({ runs: [{ ...producer, head_sha: head }], self: childSelf }) });
 assert.equal(childDecision.coverage, 'reuse', 'same-tree direct parent proof');
 assert.equal((await planVerification({ cwd: directory, env: { ...environment, GITHUB_SHA: child }, plan,
  fetch: network({ runs: [parentRun], self: childSelf }) })).coverage, 'full', 'does not search earlier ancestors');
 const code = await commit('application.mjs', 'export const value = 1;\n');
 assert.equal((await planVerification({ cwd: directory, env: { ...environment, GITHUB_SHA: code }, plan,
  fetch: network({ runs: [{ ...producer, head_sha: child }], self: { ...current, head_sha: code } }) })).coverage, 'full', 'code change refuses light');
 // A rename from code into the allowlist still contains a code deletion.
 git('mv', 'application.mjs', 'HANDOVER.md'); git('commit', '--quiet', '-m', 'synthetic-base-3');
 const renameHead = git('rev-parse', 'HEAD');
 assert.equal((await planVerification({ cwd: directory, env: { ...environment, GITHUB_SHA: renameHead }, plan,
  fetch: network({ runs: [{ ...producer, head_sha: code }], self: { ...current, head_sha: renameHead } }) })).coverage, 'full', 'both rename sides inspected');
 const eventPath = join(directory, 'event.json');
 const event = { pull_request: { head: { sha: head, ref: current.head_branch, repo: fixture.repository }, base: { repo: fixture.repository } } };
 await writeFile(eventPath, JSON.stringify(event));
 const prEnv = { ...environment, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: child, GITHUB_REF: 'refs/pull/1/merge' };
 const prSelf = { ...current, event: 'pull_request' }; // API identifies the head; the runner tests the merge SHA.
 const headPush = { ...producer, head_branch: current.head_branch };
 let polls = 0, sleeps = 0;
 const waiting = network({ runs: [headPush], self: prSelf, listing: matches => {
  polls++; return list(matches.map(run => polls < 3 ? { ...run, status: 'in_progress', conclusion: null } : run));
 } });
 assert.equal((await planVerification({ cwd: directory, env: prEnv, plan, fetch: waiting, sleep: async () => { sleeps++; } })).coverage, 'reuse', 'waits for separate head push');
 assert.equal(sleeps, 2);
 assert.equal((await planVerification({ cwd: directory, env: { ...prEnv, GITHUB_SHA: code }, plan, fetch: network({ runs: [headPush], self: prSelf }) })).coverage, 'full', 'merge tree differs');
 assert.equal((await planVerification({ cwd: directory, env: prEnv, plan, fetch: network({ runs: [], self: prSelf }), sleep: async () => {} })).coverage, 'full', 'bounded missing producer');
 for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
  assert.equal((await planVerification({ cwd: directory, env: prEnv, plan, fetch: network({ runs: [{ ...headPush, conclusion }], self: prSelf }) })).coverage, 'full', conclusion);
 }
 await writeFile(eventPath, JSON.stringify({ pull_request: { ...event.pull_request, head: { ...event.pull_request.head, repo: { id: 44, full_name: 'synthetic-base-6/synthetic-base-7' } } } }));
 assert.equal((await planVerification({ cwd: directory, env: prEnv, plan, fetch: network({ self: prSelf }) })).coverage, 'full', 'fork PR');
 for (const fetch of [async () => new Response('{}', { status: 403 }), async () => new Response('invalid JSON'), async () => { throw Error('synthetic-base-9'); }]) {
  assert.equal((await planVerification({ cwd: directory, env: environment, plan, fetch })).coverage, 'full', 'lookup failures run verification');
 }
 assert.equal((await decide({ listing: matches => ({ total_count: 2, workflow_runs: matches }) })).coverage, 'full', 'partial page refuses reuse');
 const hundred = Array.from({ length: 100 }, (_, index) => ({ ...producer, id: 1000 + index, conclusion: 'failure' }));
 const pages = [];
 assert.equal((await decide({ listing: (_, url) => {
  const page = Number(url.searchParams.get('page')); pages.push(page);
  return { total_count: 101, workflow_runs: page === 1 ? hundred : [producer] };
 } })).coverage, 'reuse', 'complete pagination finds newest push');
 assert.deepEqual(pages, [1, 2]);
 const nightlySelf = { ...current, event: 'schedule', head_branch: 'main' };
 const nightly = { ...producer, event: 'schedule', head_branch: 'main' };
 const nightlyEnv = { ...environment, GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main', NIGHTLY_CACHE_HIT: 'true' };
 const nightlyPlan = { ...plan, nightly: fixture.nightly };
 const nightlyJobs = run => proofJobs(run, ['plan', 'nightly-proof', 'verify', 'shards (journey)']);
 const nightlyDecision = runs => planVerification({ cwd: directory, env: nightlyEnv, plan: nightlyPlan, fetch: network({ runs, self: nightlySelf, jobs: nightlyJobs }) });
 assert.equal((await nightlyDecision([nightly])).coverage, 'reuse', 'marker and newest successful nightly proof');
 assert.equal((await nightlyDecision([nightly, { ...nightly, id: 4001, conclusion: 'failure' }])).coverage, 'full', 'failed nightly defeats immutable old marker');
 assert.equal((await nightlyDecision([{ ...nightly, head_branch: current.head_branch }])).coverage, 'full', 'untrusted marker producer');
 assert.equal((await planVerification({ cwd: directory, env: nightlyEnv, plan: nightlyPlan, fetch: network({ runs: [nightly], self: nightlySelf, jobs: nightlyJobs, latest: { [nightly.id]: { ...nightly, run_attempt: 2, conclusion: 'failure' } } }) })).coverage, 'full', 'failed latest nightly attempt rejects marker');
 const tag = await planVerification({ env: { ...nightlyEnv, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1' }, plan: nightlyPlan, fetch: () => assert.fail('tag must bypass lookup') });
 assert.equal(tag.tier, 'all'); assert.equal(tag.matrix.include.length, plan.push.length + fixture.nightly.length);
 const emptyNight = await planVerification({ env: { ...nightlyEnv, NIGHTLY_CACHE_HIT: '' }, plan, fetch: network({ self: nightlySelf }) });
 assert.deepEqual(emptyNight.matrix.include, [], 'empty nightly is a deliberate empty plan');
 // Exercise matrix CLI and generation without pinning a hash or a cron value.
 const scripts = join(directory, 'scripts');
 for (const name of ['verify-ci.mjs', 'verify-app.mjs', 'verify-plan.mjs', 'verify-evidence.mjs', 'verify-light.mjs']) await copyFile(resolve(import.meta.dirname, '../export', name), join(scripts, name));
 await writeFile(join(directory, 'verification.json'), JSON.stringify(nightlyPlan));
 for (const [tier, expected] of [['push', plan.push], ['nightly', fixture.nightly], ['all', [...plan.push, ...fixture.nightly]]]) {
  const command = spawnSync(process.execPath, [join(scripts, 'verify-ci.mjs'), '--matrix', tier], { cwd: directory, encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  assert.deepEqual(JSON.parse(command.stdout).include, expected.map(({ name, browser }) => ({ name, browser })));
 }
 const output = join(directory, 'planning-output');
 const command = spawnSync(process.execPath, [join(scripts, 'verify-ci.mjs'), '--plan'], { cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '', GITHUB_OUTPUT: output, TIER: 'push' } });
 assert.equal(command.status, 0, command.stderr);
 const outputs = Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
 assert.equal(outputs.coverage, 'full'); assert.equal(outputs.has_shards, 'true');
 assert.deepEqual(JSON.parse(outputs.matrix).include, plan.push.map(({ name, browser }) => ({ name, browser })));
 const template = await readFile(resolve(import.meta.dirname, '../export/verify-nightly.yml'), 'utf8');
 const rendered = renderVerifySchedule(template, 'synthetic-base-1');
 assert.equal(renderVerifySchedule(rendered, 'synthetic-base-1'), rendered);
 const cron = /cron: '([^']+)'/.exec(rendered)[1].split(' ');
 assert.ok(Number(cron[0]) >= 0 && Number(cron[0]) < 60 && Number(cron[1]) >= 2 && Number(cron[1]) < 8);
 const weekdays = cron[4].split(',').map(Number);
 const scheduled = Array.from({ length: 7 }, (_, day) => new Date(Date.UTC(2026, 0, 4 + day))).filter(date => weekdays.includes(date.getUTCDay()));
 assert.deepEqual(scheduled.map(date => date.toLocaleDateString('en', { weekday: 'long', timeZone: 'UTC' })), ['Monday', 'Thursday']);
 console.log('Planning flows passed: push wait, newest failure/latest attempt, merge trees, direct parent, light refusals, pagination, nightly marker, matrices and schedule rendering.');
});
