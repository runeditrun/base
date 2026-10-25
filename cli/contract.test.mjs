import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { exportCLI } from './export.mjs';
import { verbs, aliases, pins } from './contract.mjs';
const base = resolve(import.meta.dirname, '..');
const common = [...Object.keys(verbs), 'release'];

// A first-party seed with every declaration check reads and no runnable app.
async function structuralSeed(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-structural-')); t.after(() => rm(root, { recursive: true, force: true }));
 await exportCLI(base, root); await cp(join(base, 'onboarding'), join(root, 'scripts/base-onboarding'), { recursive: true });
 await writeFile(join(root, '.node-version'), pins.node + '\n');
 const pkg = { engines: { node: pins.node }, packageManager: `pnpm@${pins.pnpm}`, scripts: Object.fromEntries(Object.entries(aliases).map(([alias, verb]) => [alias, `node scripts/rer.mjs${verb ? ' ' + verb : ''}`])) };
 const descriptor = { version: 2, project: 'example/seed', requiredEnvironment: [], runtime: { requirements: [] }, seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(common.map(verb => [verb, { argv: ['node', 'scripts/rer.mjs', verb], inputs: ['scripts/rer.mjs'], effects: 'Structural fixture target; this check must never execute it.' }])) };
 const adapter = `import{localInstaller}from './scripts/base-onboarding/adapter.mjs';import{commandAdapter}from './scripts/base-cli/cli/adapter.mjs';const lifecycle=localInstaller({dependencies:['node',['never-execute.mjs']],build:['node',['never-execute.mjs']],migrate:['node',['never-execute.mjs']],start:['node',['never-execute.mjs']],owner:{},signIn:{}});const adapter=commandAdapter(lifecycle,{preview:['node',['never-execute.mjs']],verify:['node',['never-execute.mjs']],deploy:()=>{},portability:{export:()=>{},import:()=>{}},input:{names:{email:'email',name:'displayName'},validate:value=>value}});export{adapter as commandAdapter};\n`;
 await writeFile(join(root, 'never-execute.mjs'), "throw Error('Structural checks executed an effect')");
 const save = async (declaration = descriptor, packageJson = pkg, extra = '') => { await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(declaration)); await writeFile(join(root, 'package.json'), JSON.stringify(packageJson)); await writeFile(join(root, 'adapter.mjs'), adapter + extra); };
 const check = () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/rer.mjs'), 'check', '--profile', 'first-party', '--json'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const report = JSON.parse(result.stdout.trim()); return { ...result, report };
 };
 await save();
 return { root, descriptor, save, check };
}

test('check diagnoses command and deployment declarations, accepts corrections and refuses missing runtime code without effects', async t => {
 const { root, descriptor, save, check } = await structuralSeed(t);
 const accepted = check();
 assert.equal(accepted.status, 0, accepted.stderr);
 assert.equal(accepted.stdout.trim().split('\n').length, 1, 'JSON mode prints one result');
 // A person sees that the structural check passed, how much it read and what to run next.
 const human = spawnSync(process.execPath, [join(root, 'scripts/rer.mjs'), 'check', '--profile', 'first-party'], { cwd: root, encoding: 'utf8', timeout: 10000 });
 assert.equal(human.status, 0, human.stderr);
 assert.ok(human.stdout.includes(String(accepted.report.clauses.length)) && human.stdout.includes('rer doctor'), human.stdout);
 for (const [path, wrap] of [
  ['rer-packaging.json', spec => ({ artifact: { specInputs: spec } })],
  ['packaging.json', spec => ({ artifact: { specInputs: spec } })],
  ['scripts/delivery/base/packaging.json', spec => ({ artifact: { specInputs: spec } })],
  ['management/integration/deployment-spec.json', spec => spec],
 ]) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  for (const [first, second] of [['app', 'page'], ['app', 'websitePreview'], ['page', 'websitePreview']]) {
   const spec = { surfaces: { app: { path: '/' }, [first]: { path: '/', originVariable: 'APP_URL' }, [second]: { path: '/preview', originVariable: 'APP_URL' } } };
   await writeFile(join(root, path), JSON.stringify(wrap(spec)));
   const duplicate = check();
   assert.equal(duplicate.status, 1, `${path}: repeated origins must fail check`);
   assert.ok(duplicate.report.clauses.some(clause => !clause.ok && ['APP_URL', `surfaces.${first}`, `surfaces.${second}`].every(name => clause.message?.includes(name))));
   const deploy = spawnSync(process.execPath, [join(root, 'scripts/rer.mjs'), 'deploy', '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 10000 });
   assert.equal(deploy.status, 1);
   for (const name of ['APP_URL', `surfaces.${first}`, `surfaces.${second}`]) assert.ok((deploy.stdout + deploy.stderr).includes(name));
   spec.surfaces[second].originVariable = 'PREVIEW_URL';
   await writeFile(join(root, path), JSON.stringify(wrap(spec)));
   assert.equal(check().status, 0, `${path}: distinct origins must pass check`);
  }
  await rm(join(root, path));
 }
 const broken = structuredClone(descriptor);
 delete broken.commands.dev;
 await save(broken);
 const refused = check();
 assert.equal(refused.status, 1);
 assert.ok(refused.report.clauses.some(clause => !clause.ok && clause.message), 'the rejected declaration gives a correction');
 await save();
 const corrected = check();
 assert.equal(corrected.status, 0, corrected.stderr);
 // Missing actual exported implementation is a supply-chain failure, not a
 // declaration pin: keep the real refusal even when the declaration is valid.
 await rm(join(root, 'scripts/base-cli/cli/lifecycle.mjs'));
 const incompleteRuntime = check();
 assert.equal(incompleteRuntime.status, 1);
 assert.ok(incompleteRuntime.report.clauses.some(clause => !clause.ok && clause.message));
 await assert.rejects(stat(join(root, '.wrangler')), { code: 'ENOENT' }, 'read-only check creates no local state or credentials');
});

test("check validates a seed's CONTRACT.md Status table and names the line of each failure", async t => {
 const { root, check } = await structuralSeed(t);
 assert.equal(check().status, 0, 'a seed without CONTRACT.md is unaffected');
 const contract = ['# Example contract', '', '## Product target', '', '| | |', '| --- | --- |', '| Category | Team notes |', '| Incumbents a buyer switches from | Notion, Confluence |', '| First buyer | A US team of 20 |', '',
  '## Pages', '', '- **PAGE-001 — Create a page.** A member creates a page.', '- **PAGE-002 — Share a page.** A member shares a page.', '', '## Target clauses', '', '### Writing together', '', '#### LIVE-001 — Live editing.', 'Two members type at once.', '', '*Status:* missing.', '',
  '## Status', '', 'Judged from the code and tests at commit `0123abc` (17 October 2026).', '', '| Clause | Title | Kind | Status | Evidence | Gap |', '| --- | --- | --- | --- | --- | --- |',
  '| `PAGE-001` | Create a page | published | done | `tests/pages.test.mjs` |  |', '| `PAGE-002` | Share a page | published | partial | `src/share.mjs` | no journey |', '| `LIVE-001` | Live editing | target | missing |  | no implementation |', ''];
 const row = id => contract.findIndex(line => line.startsWith(`| \`${id}\``)) + 1;
 await mkdir(join(root, 'tests'), { recursive: true }); await mkdir(join(root, 'src'), { recursive: true });
 await writeFile(join(root, 'tests/pages.test.mjs'), ''); await writeFile(join(root, 'src/share.mjs'), '');
 // Each failure is one clause whose message starts with the CONTRACT.md line.
 const failures = async lines => {
  await writeFile(join(root, 'CONTRACT.md'), lines.join('\n')); const result = check();
  return { status: result.status, failed: result.report.clauses.filter(clause => !clause.ok).map(clause => [clause.id, /^CONTRACT\.md:(\d+): /.exec(clause.message)?.[1], clause.message]) };
 };
 assert.deepEqual(await failures(contract), { status: 0, failed: [] });
 const duplicate = [...contract]; duplicate.splice(row('PAGE-002'), 0, contract[row('PAGE-001') - 1]);
 const twice = await failures(duplicate);
 assert.equal(twice.status, 1);
 assert.deepEqual(twice.failed.map(([id, line]) => [id, Number(line)]), [['CONTRACT.status', row('PAGE-002') + 1]]);
 assert.match(twice.failed[0][2], /PAGE-001/);
 await rm(join(root, 'tests/pages.test.mjs'));
 const unproven = await failures(contract);
 assert.equal(unproven.status, 1);
 assert.deepEqual(unproven.failed.map(([id, line]) => [id, Number(line)]), [['CONTRACT.evidence.PAGE-001', row('PAGE-001')]]);
 assert.match(unproven.failed[0][2], /tests\/pages\.test\.mjs/);
});
