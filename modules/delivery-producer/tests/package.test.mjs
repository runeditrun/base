import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {producePackage, packagingConfig} from '../package.mjs';
import {exportProducer} from '../export.mjs';
import {generateManagedWorkflow} from '../generators/managed.mjs';
import {deploymentSpec} from '../spec.mjs';

const workflowRef = `publisher/delivery/.github/workflows/trusted-build.yml@${'a'.repeat(40)}`;
const config = () => ({schema:1, project:{schema:1,projectId:'publisher/app',name:'App',sourceRepository:'https://github.com/octocat/Hello-World',license:'MIT',deployment:{target:'cloudflare-workers',artifactFile:'app.json'},operations:{build:'make build',verify:'make verify',artifact:'node scripts/delivery/base/cli.mjs artifact --config scripts/delivery/base/packaging.json',recovery:'Restore retained data.'}}, managed:{workflowRef,artifactFile:'app.json',buildProfile:'project',verificationProfiles:['full']}, artifact:{specInputs:{recovery:'Restore retained data.',providerEffects:['outbound-mail'],surfaces:{app:{path:'/',originVariable:'APP_ORIGIN'}},initialSetup:{path:'/setup-status',pendingStatus:409,completeStatus:200}}},edition:{manifestFile:'edition.json',componentId:'publisher/app'}});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'packaging-kit-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'dist/server'),{recursive:true});
  await mkdir(join(root,'dist/client'),{recursive:true});
  await writeFile(join(root,'dist/server/wrangler.json'), JSON.stringify({compatibility_date:'2026-09-08'}));
  await writeFile(join(root,'dist/server/index.js'), 'export default {};\r\n');
  await writeFile(join(root,'dist/client/image.png'), Buffer.from([0,255,13,10]));
  await writeFile(join(root,'edition.json'), JSON.stringify({schemaVersion:1,components:[{id:'publisher/app',role:'edition'}]}));
  return root;
}
test('one producer emits all files, exact payload identities and current seed declarations', async t => {
  const root = await fixture(t), policy = config();
  const output = await producePackage({root,config:policy});
  const project = JSON.parse(await readFile(output.project));
  assert.deepEqual(project,policy.project);
  assert.equal(await readFile(output.workflow,'utf8'),generateManagedWorkflow(policy.managed));
  const manifest = JSON.parse(await readFile(output.artifact));
  assert.equal(manifest.schema,2);
  assert.equal(manifest.mainModule,'index.js');
  assert.deepEqual(manifest.deploymentSpec.providerEffects,policy.artifact.specInputs.providerEffects);
  assert.deepEqual(manifest.deploymentSpec.surfaces,policy.artifact.specInputs.surfaces);
  assert.deepEqual(manifest.deploymentSpec.initialSetup,policy.artifact.specInputs.initialSetup);
  for (const entry of [...manifest.modules,...manifest.assets]) {
    const bytes = await readFile(join(root,'rer-package/delivery-artifact',entry.payload));
    assert.equal(entry.size,bytes.length);
    assert.equal(entry.sha256,createHash('sha256').update(bytes).digest('hex'));
  }
  assert.deepEqual(await readFile(join(root,'rer-package/delivery-artifact',manifest.assets[0].payload)),Buffer.from([0,255,13,10]));
  const again = await producePackage({root,config:policy,output:'second'});
  assert.deepEqual(await readFile(again.artifact),await readFile(output.artifact));
  assert.deepEqual(await readFile(again.project),await readFile(output.project));
  assert.deepEqual(await readFile(again.workflow),await readFile(output.workflow));
  await assert.rejects(producePackage({root,config:policy}),/fresh/);
});
test('exported runtime works inside an independent seed with no Base checkout dependency', async t => {
  const root = await fixture(t), policy = config();
  const exported = await exportProducer({root,config:policy});
  assert(!((await readdir(exported)).includes('tests')));
  const run = args => execFileSync(process.execPath,[join(exported,'cli.mjs'),...args],{cwd:root,stdio:'pipe'});
  run(['artifact','--config','scripts/delivery/base/packaging.json']);
  const original = await readFile(join(root,'delivery-artifact/app.json'));
  run(['package','--config','scripts/delivery/base/packaging.json']);
  assert.deepEqual(await readFile(join(root,'rer-package/delivery-artifact/app.json')),original);
  assert.throws(() => run(['package','--config','scripts/delivery/base/packaging.json']));
  assert.throws(() => run(['artifact','--config','scripts/delivery/base/packaging.json','--root',root,'--root',root]));
});
test('mismatched identities, invalid manifest selection and unsafe output fail without touching source', async t => {
  const root = await fixture(t);
  const policy = config();
  for (const changed of [{...policy,managed:{...policy.managed,artifactFile:'other.json'}},{...policy,schema:2},{...policy,managed:{...policy.managed,verificationProfiles:['full','visual']}},{...policy,project:{...policy.project,deployment:{...policy.project.deployment,target:'other-provider'}}}]) assert.throws(() => packagingConfig(changed));
  for (const manifest of [{schemaVersion:1,components:[{id:'publisher/app',role:'module'}]},{schemaVersion:1,components:[{id:'publisher/app',role:'edition'},{id:'publisher/app',role:'edition'}]}]) {
    await writeFile(join(root,'edition.json'),JSON.stringify(manifest));
    await assert.rejects(producePackage({root,config:policy}));
  }
  await writeFile(join(root,'edition.json'),JSON.stringify({schemaVersion:1,components:[{id:'publisher/app',role:'edition'}]}));
  await symlink(join(root,'dist'),join(root,'linked'));
  for (const output of ['../escape','.git/packaging','linked/package','dist/server']) await assert.rejects(producePackage({root,config:policy,output}));
  assert.equal(await readFile(join(root,'dist/server/index.js'),'utf8'),'export default {};\r\n');
  await writeFile(join(root,'dist/server/.env'),'synthetic fixture bytes');
  await assert.rejects(producePackage({root,config:policy}),/Private/);
  await assert.rejects(readFile(join(root,'rer-package/rer-project.json')));
});
test('declarations reject malformed effects, readiness, surface address conflicts and setup states', async t => {
  const root = await fixture(t);
  const policy = config().artifact.specInputs;
  for (const mutation of [{providerEffects:['outbound-mail','outbound-mail']},{providerEffects:['bad effect']},{surfaces:{app:{path:'//bad',originVariable:'APP_ORIGIN',hostnameVariable:'APP_HOST'}}},{surfaces:{page:{path:'/'}}},{surfaces:{app:{path:'/',readiness:[{path:'/',statuses:[999]}]}}},{initialSetup:{path:'/status',pendingStatus:200,completeStatus:200}},{initialSetup:{path:'/status',pendingStatus:409,completeStatus:'200'}}]) await assert.rejects(deploymentSpec(root,{...policy,...mutation}));
});
test('workflow profiles are explicit and require full as the default', () => {
  const input = {workflowRef,artifactFile:'app.json',verificationProfiles:['full']};
  assert.match(generateManagedWorkflow(input),/options: \[full\]/);
  for (const profiles of [[],['visual'],['full','full'],['full','arbitrary']]) assert.throws(() => generateManagedWorkflow({...input,verificationProfiles:profiles}));
});

test('SSH and credential-store build entries cannot be packaged', async t => {
  const root = await fixture(t), policy = config();
  for (const name of ['id_rsa','id_ed25519','id_ecdsa.pub','id_dsa','credentials','credentials.ini','credentials.toml','credentials.yaml']) {
    await writeFile(join(root,'dist/server',name),'synthetic fixture bytes');
    await assert.rejects(producePackage({root,config:policy}),/Private/);
    await rm(join(root,'dist/server',name));
  }
});
