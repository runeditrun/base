import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { exportCLI } from './export.mjs';
import { fixture } from '../modules/release/test-fixture.mjs';
import { contractText } from '../modules/release/contract-fixture.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
const base=resolve(import.meta.dirname,'..');

test('verification and release refuse stale project file hashes, even when the release checkout is already corrected', async t => {
 const f = fixture(t);
 const path = 'rer-setup.json';
 const file = Buffer.from('{ "changed": true }\r\n');
 const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
 const declared = sha256('{}'), actual = sha256(file);
 const manifest = sha => ({
  projectId: f.options.project, sourceRepository: f.options.repository,
  setup: { path, sha256: sha },
  resources: [{ path, digest: `sha256:${sha}` }],
 });
 const save = (name, value) => writeFile(join(f.repo, name), JSON.stringify(value));
 await save('edition.json', { id: f.options.project });
 await save('OPERATIONS.json', { version: 2, project: f.options.project, requiredEnvironment: [], runtime: { requirements: [] }, commands: {
  verify: { argv: ['node', '--test', 'check.test.mjs'], inputs: ['check.test.mjs'], effects: 'Run fixture verification.' },
 } });
 await writeFile(join(f.repo, path), file);
 await save('rer-project.json', manifest(declared));
 const stale = f.commit();
 const env = await isolatedQueue(t);
 const cli = (verb, ...args) => spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), verb, ...args], { cwd: f.repo, env, encoding: 'utf8', timeout: 15000 });
 const refuses = (result, exitCode) => {
  assert.equal(result.status, exitCode, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  for (const value of ['setup.sha256', 'resources[0].digest', path, declared, actual]) assert.ok(output.includes(value), output);
 };
 refuses(cli('verify'), 1);
 refuses(cli('check'), 1);
 const editionCheck = spawnSync(process.execPath, [join(base, 'edition-authoring/cli.mjs'), 'check'], { cwd: f.repo, env, encoding: 'utf8', timeout: 15000 });
 refuses(editionCheck, 1);

 const correctedFile = Buffer.from('{ "changed": true, "corrected": true }\r\n');
 await writeFile(join(f.repo, path), correctedFile);
 await save('rer-project.json', manifest(sha256(correctedFile)));
 f.commit();
 const check = cli('check');
 assert.equal(check.status, 0, check.stdout + check.stderr);
 const result = cli('release', '--repo', f.repo, '--ref', stale, '--project', f.options.project,
  '--repository', f.options.repository, '--output', f.options.output, '--local-verify', '--tag');
 refuses(result, 2);
 assert.equal(execFileSync('git', ['-C', f.repo, 'tag', '--list'], { encoding: 'utf8' }), '');
 await assert.rejects(readFile(join(f.options.output, 'release-receipt.json')), { code: 'ENOENT' });
});

test('exported release dispatcher preserves local producer receipts, flags and exits',async t=>{
 const env=await isolatedQueue(t);
 const f=fixture(t),portable=join(f.temporary,'portable');
 await exportCLI(base,portable);await cp(join(base,'onboarding'),join(portable,'scripts/base-onboarding'),{recursive:true});
 const invoke=args=>spawnSync(process.execPath,[join(portable,'scripts/rer.mjs'),'release','--repo',f.repo,'--project','just-every/run-lamp','--repository','https://github.com/just-every/run-lamp','--output',f.options.output,...args],{cwd:portable,env,encoding:'utf8',timeout:120000});
 // A contract with no published clause is refused with its own message; the same clause as a heading releases.
 const clause={id:'TEST-001',title:'Exact bytes',body:'Export the verified committed bytes.'};
 await writeFile(join(f.repo,'CONTRACT.md'),contractText([{...clause,kind:'target'}]));const unpublished=f.commit();
 const refused=invoke(['--dry-run','--ref',unpublished]);assert.equal(refused.status,2);assert.match(refused.stderr,/CONTRACT\.md must contain published clauses/);
 await writeFile(join(f.repo,'CONTRACT.md'),contractText([{...clause,form:'heading'}]));const headed=f.commit();
 const success=invoke(['--dry-run','--ref',headed]);assert.equal(success.status,0,success.stderr);const receipt=JSON.parse(success.stdout);assert.equal(receipt.status,'DRY_RUN');assert.equal(receipt.gates.verify.passed,1);assert.equal(receipt.tag.created,false);assert.equal(receipt.tag.pushed,false);
 assert.equal(JSON.parse(await readFile(join(f.options.output,receipt.siteRelease.path),'utf8')).provenance.publication,'dry-run');
 const invalid=invoke(['--unknown']);assert.equal(invalid.status,2);
 const blocked=fixture(t,'node -e "process.exit(7)"');f.repo=blocked.repo;f.options.output=blocked.options.output;
 const failed=invoke(['--dry-run']);assert.equal(failed.status,1);assert.equal(JSON.parse(failed.stdout).gates.verify.exitCode,7);
});

test('release candidate commits only coherent prerelease metadata and leaves producer gates intact', async t => {
 const env=await isolatedQueue(t), f=fixture(t), portable=join(f.temporary,'candidate-tools');
 const git=(...args)=>execFileSync('git',['-C',f.repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();
 await exportCLI(base,portable);await cp(join(base,'onboarding'),join(portable,'scripts/base-onboarding'),{recursive:true});
 const invoke=(...args)=>spawnSync(process.execPath,[join(portable,'scripts/rer.mjs'),'release','candidate','--cwd',f.repo,...args],{env,encoding:'utf8',timeout:30000});
 const original=Object.fromEntries(await Promise.all(['seed.json','package.json','RELEASE.json'].map(async path=>[path,await readFile(join(f.repo,path),'utf8')])));
 // Metadata formatting and nested version fields belong to the caller.
 for (const [path,bytes] of Object.entries(original)) {
  const value={...JSON.parse(bytes), nested:{version:'Keep this metadata'}};
  original[path]=JSON.stringify(value,null,2)+'\n'; await writeFile(join(f.repo,path),original[path]);
 }
 const before=f.commit(), current=JSON.parse(original['seed.json']).version;
 const parts=current.split('.').map(Number);parts[2]++;
 const next=parts.join('.'), tag=`v${next}-rc1`;
 // Refusals never mutate source or create a commit.
 for (const invalid of [`v${next}`, 'latest', `v${next}-01`, `v${parts[0]}.${parts[1]}.${parts[2]+1}-rc1`]) {
  const refused=invoke('--tag',invalid);assert.equal(refused.status,2,refused.stdout+refused.stderr);
  assert.equal(git('rev-parse','HEAD'),before);assert.equal(git('status','--porcelain'),'');
 }
 await writeFile(join(f.repo,'untracked.txt'),'Keep caller work');
 assert.equal(invoke('--tag',tag).status,2);assert.equal(git('rev-parse','HEAD'),before);
 const {rm}=await import('node:fs/promises');await rm(join(f.repo,'untracked.txt'));
 const success=invoke('--tag',tag,'--json');assert.equal(success.status,0,success.stderr);
 const prepared=JSON.parse(success.stdout);assert.equal(prepared.version,tag.slice(1));assert.equal(prepared.stageOnly,true);assert.equal(prepared.changed,true);
 assert.equal(git('rev-parse','HEAD^'),before);assert.equal(git('status','--porcelain'),'');assert.equal(git('tag','--list'),'');
 const changed=git('diff-tree','--no-commit-id','--name-only','-r',prepared.commit).split('\n').sort();
 assert.deepEqual(changed,Object.keys(original).sort());
 for (const [path,bytes] of Object.entries(original)) {
  const actual=await readFile(join(f.repo,path),'utf8');
  assert.equal(actual,bytes.replace(`"version": "${current}"`,`"version": "${prepared.version}"`));
 }
 const repeated=invoke('--tag',tag);assert.equal(repeated.status,0,repeated.stderr);
 assert.equal(JSON.parse(repeated.stdout).changed,false);assert.equal(git('rev-parse','HEAD'),prepared.commit);
 // The ordinary producer must read this commit's candidate version, run its
 // real frozen install/verification/scan and return a dry-run for that tag.
 const produce=(label,output)=>spawnSync(process.execPath,[join(portable,'scripts/rer.mjs'),'release','--repo',f.repo,'--project',f.options.project,'--repository',f.options.repository,'--output',output,'--tag',label,'--dry-run','--local-verify'],{env,encoding:'utf8',timeout:120000});
 const stable=produce(`v${next}`,join(f.temporary,'stable-refused'));
 assert.equal(stable.status,2);assert.match(stable.stderr,/tag must match the committed release version/);
 const dry=produce(tag,f.options.output);assert.equal(dry.status,0,dry.stdout+dry.stderr);
 const receipt=JSON.parse(dry.stdout);assert.equal(receipt.status,'DRY_RUN');assert.equal(receipt.tag.name,tag);assert.equal(receipt.tag.created,false);
 assert.equal(git('tag','--list'),'');assert.equal(git('rev-parse','HEAD'),prepared.commit);
 // The current stable core is also a supported candidate, with no patch bump.
 const same=fixture(t), sameCall=spawnSync(process.execPath,[join(base,'global/rer.mjs'),'release','candidate','--cwd',same.repo,'--tag',`v${current}-rc.2`],{env,encoding:'utf8',timeout:30000});
 assert.equal(sameCall.status,0,sameCall.stderr);assert.equal(JSON.parse(sameCall.stdout).version,`${current}-rc.2`);
});
