import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {producePackage} from '../package.mjs';
import {exportProducer} from '../export.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'optional-declarations-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const put = async (path, value) => {
    await mkdir(join(root, path, '..'), {recursive:true});
    await writeFile(join(root, path), value);
  };
  await put('dist/server/wrangler.json', JSON.stringify({compatibility_date:'2026-09-08'}));
  await put('dist/server/index.js', 'export default {fetch() {return new Response("Application");}};');
  await put('dist/client/index.html', '<main>Application</main>');
  const config = {
    schema:1,
    project:{schema:1, projectId:'publisher/app', name:'App', sourceRepository:'octocat/Hello-World', license:'MIT', deployment:{target:'cloudflare-workers', artifactFile:'app.json'}, operations:{build:'make build', verify:'make verify', artifact:'make artifact', recovery:'Restore retained data.'}},
    managed:{workflowRef:`publisher/delivery/.github/workflows/trusted-build.yml@${'a'.repeat(40)}`, artifactFile:'app.json', buildProfile:'project', verificationProfiles:['full']},
    artifact:{specInputs:{recovery:'Restore retained data.', surfaces:{app:{path:'/'}}}},
  };
  let sequence = 0;
  const emit = async () => {
    const output = await producePackage({root, config, output:`package-${sequence++}`});
    return JSON.parse(await readFile(output.artifact)).deploymentSpec;
  };
  return {root, put, config, emit};
}

test('producer emits optional app sign-in, carries adapter paths, and refuses platform-invalid declarations', async t => {
  const f = await fixture(t), app = f.config.artifact.specInputs.surfaces.app;
  assert.equal(Object.hasOwn((await f.emit()).surfaces.app, 'signIn'), false);
  for (const signIn of [{path:'/login', loginHint:true}, {path:'/', loginHint:false}, {path:'/nested//login/', loginHint:false}, {path:`/${'a'.repeat(2048)}`, loginHint:true}, {path:'/signin', loginHint:true, ownerSignIn:'/auth/owner-signin'}]) {
    app.signIn = signIn;
    assert.deepEqual((await f.emit()).surfaces.app.signIn, signIn);
  }
  const invalid = [null, false, '/login', [], {}, {path:'/login'}, {loginHint:false}, {path:'/login', loginHint:'true'}, {path:'/login', loginHint:null}, {path:'/login', loginHint:true, extra:true}, {path:'/login', loginHint:true, ownerSignIn:null}, {path:'/login', loginHint:true, ownerSignIn:false}];
  for (const ownerSignIn of ['', 'auth/owner-signin', '//evil', 'https://x', '/auth/owner-signin?x=1', '/auth/../x', '/a b']) invalid.push({path:'/login', loginHint:true, ownerSignIn});
  for (const path of [null, 1, '', 'login', '//example.test/login', 'https://example.test/login', '/login?email=x', '/login#email', '/log.in', '/a/../login', '/%2flogin', '/\\login', '/log in', '/login\n', '/登录']) invalid.push({path, loginHint:false});
  for (const signIn of invalid) {
    app.signIn = signIn;
    await assert.rejects(f.emit(), {message:'Invalid project sign-in declaration'});
  }
  delete app.signIn;
  for (const name of ['page','websitePreview']) {
    f.config.artifact.specInputs.surfaces[name] = {path:'/', signIn:{path:'/login', loginHint:false}};
    await assert.rejects(f.emit(), {message:'Invalid project sign-in declaration'});
    delete f.config.artifact.specInputs.surfaces[name];
  }
  await f.put('adapter.mjs', 'export const commandAdapter = {signInPath:"/login"};');
  await f.put('OPERATIONS.json', JSON.stringify({seedContract:{version:1, profile:'first-party', adapter:'adapter.mjs'}}));
  assert.deepEqual((await f.emit()).surfaces.app.signIn, {path:'/login', loginHint:false});
  delete f.config.artifact.specInputs.surfaces;
  assert.deepEqual((await f.emit()).surfaces, {app:{path:'/', signIn:{path:'/login', loginHint:false}}});
  f.config.artifact.specInputs.surfaces = {app:{path:'/app', signIn:{path:'/signin', loginHint:true}}};
  assert.deepEqual((await f.emit()).surfaces.app, f.config.artifact.specInputs.surfaces.app);
  delete f.config.artifact.specInputs.surfaces.app.signIn;
  const exported = await exportProducer({root:f.root, config:f.config});
  execFileSync(process.execPath, [join(exported, 'cli.mjs'), 'artifact', '--config', 'scripts/delivery/base/packaging.json'], {cwd:f.root, stdio:'pipe'});
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'delivery-artifact/app.json'))).deploymentSpec.surfaces.app.signIn, {path:'/login', loginHint:false});
  await f.put('invalid-adapter.mjs', 'export const commandAdapter = {signInPath:"//example.test/login"};');
  await f.put('OPERATIONS.json', JSON.stringify({seedContract:{adapter:'invalid-adapter.mjs'}}));
  await assert.rejects(f.emit(), {message:'Invalid project sign-in declaration'});
});

test('producer emits optional native export and refuses platform-invalid shape, path and binding coverage', async t => {
  const f = await fixture(t), inputs = f.config.artifact.specInputs;
  await f.put('dist/server/wrangler.json', JSON.stringify({
    compatibility_date:'2026-09-08',
    d1_databases:[{binding:'DB', migrations_dir:'../../migrations/db'}, {binding:'PLAIN', migrations_dir:'../../migrations/plain'}],
    durable_objects:{bindings:[{name:'CHAT_HUB', class_name:'ChatHub'}]},
    migrations:[{tag:'v1', new_sqlite_classes:['ChatHub']}],
    r2_buckets:[{binding:'FILES'}], kv_namespaces:[{binding:'CACHE'}], analytics_engine_datasets:[{binding:'EVENTS'}],
    queues:{producers:[{binding:'JOBS', queue:'jobs'}]},
  }));
  await f.put('migrations/db/001.sql', 'CREATE TABLE notes(id INTEGER);\n-- indexed content\nCREATE /* native search */ VIRTUAL\nTABLE notes_fts USING fts5(content);');
  const ordinary = "CREATE TABLE notes(content TEXT DEFAULT 'CREATE VIRTUAL TABLE fake USING fts5(x);');\n/* CREATE VIRTUAL TABLE commented USING fts5(x); */\nCREATE TRIGGER note_change AFTER INSERT ON notes BEGIN SELECT CASE WHEN 1 THEN 'CREATE VIRTUAL TABLE fake' ELSE ';' END; SELECT 1; END;\n-- CREATE VIRTUAL TABLE ignored USING fts5(x);\n";
  await f.put('migrations/plain/001.sql', ordinary);
  assert.equal(Object.hasOwn(await f.emit(), 'nativeExport'), false);
  for (const declaration of [{path:'/export', covers:['DB','CHAT_HUB']}, {path:'/', covers:['CHAT_HUB']}, {path:`/${'a'.repeat(255)}`, covers:['DB']}, {path:'/data.v1/~export_-/download/', covers:['DB']}]) {
    inputs.nativeExport = declaration;
    const spec = await f.emit();
    assert.deepEqual(spec.nativeExport, declaration);
    assert.equal(spec.recovery, inputs.recovery);
  }
  for (const declaration of [null, false, [], '/export', {}, {path:'/export'}, {covers:['DB']}, {path:'/export', covers:['DB'], extra:true}]) {
    inputs.nativeExport = declaration;
    await assert.rejects(f.emit(), {message:'Native export declaration requires exactly path and covers'});
  }
  for (const path of [null, 1, '', 'export', '//example.test/export', '/a//export', '/./export', '/a/../export', '/export?all=1', '/export#all', '/%65xport', '/\\export', '/ex port', `/${'a'.repeat(256)}`]) {
    inputs.nativeExport = {path, covers:['DB']};
    await assert.rejects(f.emit(), {message:'Native export path must be a same-origin application path such as /export'});
  }
  for (const covers of [null, 'DB', [], ['DB','DB'], Array.from({length:65}, (_, i) => `B${i}`)]) {
    inputs.nativeExport = {path:'/export', covers};
    await assert.rejects(f.emit(), {message:'Native export must cover one or more distinct bindings'});
  }
  for (const binding of ['PLAIN','FILES','CACHE','EVENTS','JOBS','MISSING','db',null,1,{}]) {
    inputs.nativeExport = {path:'/export', covers:[binding]};
    await assert.rejects(f.emit(), {message:`Native export may cover only D1 databases with virtual tables and Durable Objects: ${String(binding)}`});
  }
  inputs.nativeExport = {path:'/export', covers:['DB']};
  // A different binding's virtual table cannot establish coverage for DB.
  await f.put('migrations/db/001.sql', ordinary);
  await assert.rejects(f.emit(), {message:'Native export may cover only D1 databases with virtual tables and Durable Objects: DB'});
  await f.put('migrations/db/001.sql', 'CREATE VIRTUAL TABLE valid USING fts5(content);');
  for (const [sql, message] of [["SELECT 'unterminated", 'Unterminated SQL quote'], ['/* unterminated', 'Unterminated SQL comment'], ['CREATE TRIGGER change AFTER INSERT ON notes BEGIN SELECT 1;', 'Unterminated SQL trigger']]) {
    await f.put('migrations/db/001.sql', sql);
    await assert.rejects(f.emit(), {message});
  }
});
