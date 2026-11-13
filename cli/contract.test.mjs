import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
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

// A managed copy is the platform's install of a published release: it carries the committed `rer-upstream.json`
// release record and none of the publisher's repository automation except `.github/workflows/rer-managed.yml`.
test("check does not require a managed copy to carry the publisher's .github automation cited as evidence", async t => {
 const { root, check } = await structuralSeed(t);
 const contract = ['# Example contract', '', '## Product target', '', '| | |', '| --- | --- |', '| Category | Team notes |', '| Incumbents a buyer switches from | Notion, Confluence |', '| First buyer | A US team of 20 |', '',
  '## Pages', '', '- **PAGE-001 — Create a page.** A member creates a page.', '- **PAGE-002 — Share a page.** A member shares a page.', '',
  '## Status', '', 'Judged from the code and tests at commit `0123abc` (17 October 2026).', '', '| Clause | Title | Kind | Status | Evidence | Gap |', '| --- | --- | --- | --- | --- | --- |',
  '| `PAGE-001` | Create a page | published | done | `.github/workflows/journeys.yml` |  |', '| `PAGE-002` | Share a page | published | done | `tests/share.test.mjs` |  |', ''];
 await mkdir(join(root, '.github/workflows'), { recursive: true }); await mkdir(join(root, 'tests'), { recursive: true });
 await writeFile(join(root, '.github/workflows/rer-managed.yml'), 'name: Managed release\non: workflow_dispatch\njobs: {}\n'); await writeFile(join(root, 'tests/share.test.mjs'), '');
 await writeFile(join(root, 'CONTRACT.md'), contract.join('\n'));
 const evidence = result => result.report.clauses.filter(clause => clause.id.startsWith('CONTRACT.evidence.'));
 const upstream = JSON.stringify({ schema: 1, repository: 'runeditrun/base', tag: 'v1.2.3', commit: '0123456789abcdef0123456789abcdef01234567' }) + '\n';

 // An authoring checkout (no release record) keeps the hard existence check.
 const authoring = check();
 assert.equal(authoring.status, 1);
 assert.deepEqual(evidence(authoring).filter(clause => !clause.ok).map(clause => clause.id), ['CONTRACT.evidence.PAGE-001']);
 assert.match(evidence(authoring)[0].message, /\.github\/workflows\/journeys\.yml, which is not in this checkout/);

 // Rehearse a candidate source through the same first-party check after the
 // projection removes publisher evidence. The branch is a fixture label, not a release tag.
 const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8', stdio:'pipe'}).trim();
 await writeFile(join(root, '.github/workflows/journeys.yml'), 'name: Publisher\non: push\n');
 await writeFile(join(root, 'rer-project.json'), JSON.stringify({schema:1, projectId:'example/seed', sourceRepository:'runeditrun/base', deployment:{target:'cloudflare-workers'}, operations:{
  build: `node -e "const {execFileSync:g}=require('node:child_process');if(g('git',['rev-list','--count','HEAD']).toString().trim()!=='2'||g('git',['remote']).toString().trim())process.exit(1)"`,
  verify: 'node scripts/rer.mjs check --profile first-party',
 }}));
 git('init','-q'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
 git('add','.'); git('commit','-qm','Synthetic candidate source');
 const label = 'v1.2.3-rc1'; git('branch', label);
 const rehearsal = spawnSync(process.execPath, [join(root, 'scripts/rer.mjs'), 'rehearse', '--cwd', root, '--ref', label, '--json', '--keep'], {encoding:'utf8', timeout:45000});
 const rehearsed = JSON.parse(rehearsal.stdout.trim().split('\n').at(-1));
 if (rehearsed.captureLog) t.after(() => rm(dirname(rehearsed.captureLog), {recursive:true, force:true}));
 if (rehearsed.scratch) t.after(() => rm(dirname(rehearsed.scratch), {recursive:true, force:true}));
 assert.equal(rehearsal.status, 0, rehearsal.stdout + rehearsal.stderr + (rehearsed.captureLog ? await readFile(rehearsed.captureLog,'utf8') : ''));
 assert.ok(rehearsed.operations.every(operation => operation.status === 'PASS'));
 await rm(join(root, '.github/workflows/journeys.yml'));

 // A record that is not exactly the platform's, or not a regular file, does not mark a managed copy.
 for (const bad of ['{}', upstream.replace('"schema":1', '"schema":2'), upstream.replace('v1.2.3', 'latest'), JSON.stringify({ ...JSON.parse(upstream), extra: 1 }), 'not json']) {
  await writeFile(join(root, 'rer-upstream.json'), bad);
  assert.equal(check().status, 1, `${bad.slice(0, 30)} must not mark a managed copy`);
 }
 await rm(join(root, 'rer-upstream.json')); await mkdir(join(root, 'rer-upstream.json'));
 assert.equal(check().status, 1, 'a directory is not a release record');
 await rm(join(root, 'rer-upstream.json'), { recursive: true });

 // A managed copy: the .github evidence is skipped, and the skip is named.
 await writeFile(join(root, 'rer-upstream.json'), upstream);
 const managed = check();
 assert.equal(managed.status, 0, managed.stdout);
 const skipped = evidence(managed).find(clause => clause.id === 'CONTRACT.evidence.PAGE-001');
 assert.ok(skipped.ok);
 assert.match(skipped.message, /skipped in a managed copy/);
 assert.match(skipped.message, /\.github\/workflows\/journeys\.yml/);

 // Every other evidence path is still a hard existence check in a managed copy, and so are paths that only look like .github.
 await rm(join(root, 'tests/share.test.mjs'));
 const missing = check();
 assert.equal(missing.status, 1);
 assert.deepEqual(evidence(missing).filter(clause => !clause.ok).map(clause => clause.id), ['CONTRACT.evidence.PAGE-002']);
 for (const sneaky of ['.github/../src/gone.mjs', 'src/.github/workflows/x.yml', '.githubx/workflows/x.yml', '.github-extra/x.yml']) {
  await writeFile(join(root, 'tests/share.test.mjs'), ''); // restore PAGE-002 so only the sneaky path can fail
  await writeFile(join(root, 'CONTRACT.md'), contract.join('\n').replace('`.github/workflows/journeys.yml`', `\`${sneaky}\``));
  const result = check();
  assert.equal(result.status, 1, `${sneaky} stays a hard check in a managed copy`);
  assert.deepEqual(evidence(result).filter(clause => !clause.ok).map(clause => clause.id), ['CONTRACT.evidence.PAGE-001']);
 }
});
