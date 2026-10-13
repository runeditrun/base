import { queuedEntrypoint } from '../../onboarding/queued-entry.mjs';
const queuedExit=await queuedEntrypoint(import.meta.url,'verify:browser');
if(queuedExit!==null)process.exit(queuedExit);
// Real-edition acceptance. Requires sibling Ferry/Beacon checkouts and Playwright.
// All source snapshots, npm extraction and installed applications live outside the workspace.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchDiagnostics, launchTimeoutMs } from './launch-diagnostics.mjs';
const run = promisify(execFile);
const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seeds = resolve(launcher, '../..');
const work = await mkdtemp(join(tmpdir(), 'rer-launcher-acceptance-'));
const evidence = process.env.RER_ACCEPTANCE_EVIDENCE || join(tmpdir(), 'rer-launcher-acceptance-evidence');
await mkdir(evidence, { recursive: true });
const children = new Set();
let browser;
const answers = { name: 'Harbour Sales', ownerName: 'River Owner', email: 'river@example.test', timeZone: 'Australia/Brisbane', currency: 'AUD', target: 'local' };
async function git(cwd, ...args) { return (await run('git', args, { cwd })).stdout.trim(); }
async function snapshot(name, sourceName) {
 const source = join(seeds, sourceName), target = join(work, `${name}-upstream`);
 await mkdir(target);
 const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: source, maxBuffer: 20 * 1024 * 1024 });
 const files = [...new Set(stdout.split('\0').filter(Boolean))].filter(file => !file.split('/').some(part => ['.git', '.seed', 'node_modules', '.wrangler', '.tanstack', 'dist', '.output', 'test-results', 'playwright-report'].includes(part)) && !/(^|\/)(\.env(?:\..*)?|\.dev\.vars.*|wrangler\.toml)$|\.(?:log|tsbuildinfo)$/.test(file));
 for (const file of files) {
  const path = join(source, file), stat = await lstat(path).catch(() => null);
  if (!stat?.isFile()) continue;
  await mkdir(dirname(join(target, file)), { recursive: true });
  await cp(path, join(target, file));
 }
 await git(target, 'init', '-q');
 await git(target, 'add', '.');
 await git(target, '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.test', 'commit', '-qm', 'Real current edition source snapshot');
 return { target, commit: await git(target, 'rev-parse', 'HEAD') };
}
async function stop(child) {
 if (child.exitCode !== null) return;
 child.kill('SIGTERM');
 await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Launcher did not stop cleanly')), 20000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
 });
 children.delete(child);
}
async function launch(bin, name, args) {
 const started = performance.now();
 const child = spawn(process.execPath, [bin, name, '--no-open', ...args], { cwd: work, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
 children.add(child);
 let output = '', sourceReadyMs;
 const collect = data => {
  output += data;
  if (sourceReadyMs === undefined && output.includes(`Opening ${name} setup;`)) sourceReadyMs = Math.round(performance.now() - started);
 };
 child.stdout.on('data', collect);
 child.stderr.on('data', collect);
 const origin = await new Promise((resolve, reject) => {
  let finished = false;
  const onExit = code => finish(Error(`Launcher exited ${code}: ${output}`));
  function finish(error, value) {
   if (finished) return; finished = true;
   clearInterval(check); clearTimeout(deadline); child.off('exit', onExit);
   error ? reject(error) : resolve(value);
  }
  const deadline = setTimeout(async () => {
   clearInterval(check);
   try {
    const directory = args[args.indexOf('--directory') + 1];
    const diagnostics = await launchDiagnostics(child, started, output, directory, { sourceReadyMs });
    await writeFile(join(evidence, `${name}-launch-failure.json`), diagnostics);
    finish(Error(`Launcher timeout: ${diagnostics}`));
   } catch (error) { finish(Error(`Launcher timeout; diagnostics failed (${error.message}): ${output}`)); }
  }, launchTimeoutMs);
  const check = setInterval(() => { const match = output.match(/installer: (http:\/\/127\.0\.0\.1:\d+)/); if (match) finish(null, match[1]); }, 50);
  child.once('exit', onExit);
 });
 const elapsedMs = Math.round(performance.now() - started);
 console.log(JSON.stringify({ launcherStartup: name, elapsedMs, sourceReadyMs, installerReadyMs: elapsedMs - sourceReadyMs }));
 return { child, origin };
}
async function session(origin) {
 const response = await fetch(origin), html = await response.text();
 const token = html.match(/name="installer-token" content="([a-f0-9]+)"/)[1];
 const headers = { 'X-Installer-Token': token, Cookie: response.headers.get('set-cookie').split(';')[0], Origin: origin, 'Content-Type': 'application/json' };
 return { get: async path => { const response = await fetch(origin + path, { headers }); assert.equal(response.status, 200); return response.json(); } };
}
try {
 const packageResult = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', work], { cwd: launcher })).stdout)[0];
 assert(packageResult.files.every(file => /^(bin\/|lib\/|README\.md$|LICENSE$|package\.json$)/.test(file.path)), 'npm package includes only launcher distribution files');
 await writeFile(join(evidence, 'npm-pack-files.json'), JSON.stringify(packageResult.files, null, 2));
 await cp(join(work, packageResult.filename), join(evidence, packageResult.filename));
 await run('tar', ['-xzf', join(work, packageResult.filename), '-C', work]);
 const bin = join(work, 'package/bin/rer-setup.mjs');
 const ferry = await snapshot('ferry', 'sales-ferry'), beacon = await snapshot('beacon', 'crisp');
 const pw = await import(pathToFileURL(join(seeds, 'sales-ferry/node_modules/@playwright/test/index.mjs')));
 browser = await pw.chromium.launch({ headless: true });
 for (const [name, upstream] of [['ferry', ferry], ['beacon', beacon]]) {
  const dest = join(work, `${name}-empty`), running = await launch(bin, name, ['--repository', upstream.target, '--ref', upstream.commit, '--directory', dest, '--no-prefill', '--agent']);
  assert.equal(await lstat(join(dest, 'node_modules')).catch(() => null), null);
  assert.equal(await git(dest, 'rev-parse', 'HEAD'), upstream.commit);
  const receipt = JSON.parse(await readFile(join(dest, '.git/rer-setup.json'), 'utf8'));
  assert(JSON.stringify(receipt).includes(upstream.commit));
  await writeFile(join(evidence, `${name}-receipt.json`), JSON.stringify(receipt, null, 2));
  const api = await session(running.origin), state = await api.get('/api/state'), handoff = await api.get('/api/agent-handoff');
  assert.deepEqual(state.draft, {});
  assert.equal(state.phase, 'ready');
  assert.equal(await realpath(handoff.root), await realpath(dest)); assert.equal(handoff.sessionId, state.sessionId);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(running.origin); await page.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#name').inputValue(), '');
  await page.screenshot({ path: join(evidence, `${name}-no-answers.png`), fullPage: true });
  if (name === 'ferry') {
   const partialFile = join(work, 'partial.json');
   await writeFile(partialFile, JSON.stringify({ name: 'Owner saved choice' }));
   await run(process.execPath, ['scripts/installer-fill.mjs', '--url', running.origin, '--session', state.sessionId, '--file', partialFile, '--status', 'complete', '--topic', 'workspace'], { cwd: dest });
   const attached = await api.get('/api/state');
   assert.equal(attached.draft.name, 'Owner saved choice');
   assert.equal(attached.agent.mode, 'connected');
  }
  await page.close(); await stop(running.child);
  await writeFile(join(dest, 'owner-custom.txt'), 'Keep this owner edit\n');
  await assert.rejects(run(process.execPath, [bin, name, '--directory', dest, '--repository', upstream.target, '--no-open'], { cwd: work }), /already|exist|resume/i);
  await rm(upstream.target, { recursive: true, force: true });
  const resumed = await launch(bin, name, ['--directory', dest, '--resume']);
  assert.equal(await readFile(join(dest, 'owner-custom.txt'), 'utf8'), 'Keep this owner edit\n');
  assert.equal(await git(dest, 'rev-parse', 'HEAD'), upstream.commit);
  if (name === 'ferry') assert.equal((await (await session(resumed.origin)).get('/api/state')).draft.name, 'Owner saved choice');
  await stop(resumed.child);
  console.log(JSON.stringify({ scenario: `${name}: real exact source, dependency-free onboarding, handoff, overwrite refusal, offline resume`, result: 'passed', commit: upstream.commit }));
 }
 const fresh = await snapshot('ferry-install', 'sales-ferry'), dest = join(work, 'ferry-installed');
 const answerPath = join(work, 'answers.json'); await writeFile(answerPath, JSON.stringify(answers));
 const running = await launch(bin, 'ferry', ['--repository', fresh.target, '--ref', fresh.commit, '--directory', dest, '--answers', answerPath]);
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 await page.goto(running.origin); await page.getByRole('heading', { name: 'Ready to install' }).waitFor();
 assert.equal(await page.locator('#fields input').count(), 0);
 await page.screenshot({ path: join(evidence, 'ferry-ready.png'), fullPage: true });
 await page.locator('#approve').click();
 await page.getByRole('heading', { name: 'Your workspace is ready' }).waitFor({ timeout: 300000 }).catch(async error => { throw Error(`${error.message}\n${await readFile(join(dest, '.seed/installer/local-app.log'), 'utf8').catch(() => 'No app log')}`); });
 const state = await (await session(running.origin)).get('/api/state'), origin = new URL(state.appUrl).origin;
 assert.equal((await fetch(origin + '/api/session')).status, 401);
 await page.goto(origin + '/signin'); await page.getByRole('button', { name: 'Sign in to local workspace' }).click(); await page.waitForURL(origin + '/app');
 const response = await page.request.get(origin + '/api/session'); assert.equal(response.status(), 200);
 const { operator } = await response.json(); assert.equal(operator.name, answers.ownerName); assert.equal(operator.email, answers.email);
 assert.equal((await lstat(join(dest, 'node_modules'))).isSymbolicLink(), false);
 const sql = 'SELECT organization_name, time_zone, default_currency FROM business_settings; SELECT (SELECT count(*) FROM operators) AS owners, (SELECT count(*) FROM setup_owner) AS setup_owners, (SELECT count(*) FROM pipeline_stages) AS stages, (SELECT count(*) FROM people) AS people, (SELECT count(*) FROM deals) AS deals, (SELECT count(*) FROM activities) AS activities, (SELECT count(*) FROM organizations) AS organizations;';
 const { stdout } = await run('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.toml', '--command', sql, '--json'], { cwd: dest, maxBuffer: 4 * 1024 * 1024 });
 const results = JSON.parse(stdout).flatMap(item => item.results);
 assert.deepEqual(results[0], { organization_name: answers.name, time_zone: answers.timeZone, default_currency: answers.currency });
 assert.deepEqual(results[1], { owners: 1, setup_owners: 1, stages: 4, people: 0, deals: 0, activities: 0, organizations: 0 });
 await page.screenshot({ path: join(evidence, 'ferry-installed.png'), fullPage: true });
 console.log(JSON.stringify({ scenario: 'packed external launcher: approved Ferry install, fresh dependencies, native sign-in, empty real database', result: 'passed', evidence }));
 await writeFile(join(evidence, 'acceptance.json'), JSON.stringify({ result: 'passed', package: packageResult.filename, node: process.version, scenarios: ['Ferry and Beacon exact source acquisition from real current edition snapshots', 'Dependency-free no-answer onboarding stays idle until approval', 'Session-bound agent fill and handoff', 'Existing destination refused without overwrite', 'Offline resume preserves custom file and answers', 'All answers proceed directly to owner approval', 'Fresh Ferry dependency install, native local sign-in and empty real database'], owner: operator, database: results }, null, 2));
 await page.close(); await stop(running.child);
} finally {
 await browser?.close();
 for (const child of children) await stop(child);
 await rm(work, { recursive: true, force: true });
}
