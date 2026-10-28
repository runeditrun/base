import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {deploymentSpec, validateCandidateSpec} from '../spec.mjs';
import {portableResourceCapability, assertPortableResourceSupport} from '../capabilities.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const policy = {recovery:'Retain source and restore data into separate resources.'};
// Structure emitted by @cloudflare/vite-plugin 1.54.5 for the Base reference.
const emitted = () => ({configPath:'/build/wrangler.jsonc',userConfigPath:'/build/wrangler.jsonc',topLevelName:'reference',definedEnvironments:[],compatibility_date:'2026-09-08',compatibility_flags:['nodejs_compat'],jsx_factory:'React.createElement',jsx_fragment:'React.Fragment',rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}],name:'reference',main:'index.js',triggers:{crons:['*/10 * * * *']},assets:{directory:'../client'},vars:{},durable_objects:{bindings:[]},workflows:[],migrations:[],exports:{},kv_namespaces:[],cloudchamber:{},send_email:[],queues:{producers:[{binding:'JOBS',queue:'reference-jobs'}],consumers:[{queue:'reference-jobs',max_batch_size:10,max_retries:3}]},connect:[],r2_buckets:[],d1_databases:[{binding:'DB',database_name:'reference',database_id:'source-account-id',migrations_dir:'../../migrations/core'}],vectorize:[],ai_search_namespaces:[],ai_search:[],agent_memory:[],hyperdrive:[],services:[],analytics_engine_datasets:[],dispatch_namespaces:[],mtls_certificates:[],pipelines:[],secrets_store_secrets:[],artifacts:[],unsafe_hello_world:[],flagship:[],worker_loaders:[],ratelimits:[],vpc_services:[],vpc_networks:[],logfwdr:{bindings:[]},python_modules:{exclude:['**/*.pyc']},dev:{ip:'localhost',local_protocol:'http',upstream_protocol:'http',enable_containers:true,generate_types:false},no_bundle:true});
async function project(t, config = emitted()) {
  const root = await mkdtemp(join(tmpdir(), 'delivery-spec-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root,'dist/server'), {recursive:true});
  await mkdir(join(root,'migrations/core'), {recursive:true});
  await writeFile(join(root,'migrations/core/001.sql'), 'CREATE TABLE example (id INTEGER);\n');
  await save(root,config);
  return root;
}
const save = (root,config) => writeFile(join(root,'dist/server/wrangler.json'), JSON.stringify(config));
test("deployment specification preserves or refuses each emitted configuration", async t => {
  const step = namedSteps(t);
  await step('actual emitted configuration shape preserves exact prior producer contract', async t => {
    const root = await project(t);
    const sql = await readFile(join(root,'migrations/core/001.sql'),'utf8');
    assert.deepEqual(await deploymentSpec(root,policy), {schema:1,resources:[{kind:'d1',binding:'DB'},{kind:'queue',binding:'JOBS'}],migrations:[{binding:'DB',name:'001.sql',sha256:hash(sql),sql}],compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],durableObjects:[],durableObjectMigrations:[],publicVariables:{},secretNames:[],optionalSecretNames:[],schedules:['*/10 * * * *'],queueConsumers:[{binding:'JOBS',maxBatchSize:10,maxBatchTimeout:5,maxRetries:3}],healthPath:'/health',recovery:policy.recovery});
    assert(!JSON.stringify(await deploymentSpec(root,policy)).includes('source-account-id'));
  });

  await step('HappyToHelp/Lamp binding shapes preserve queues, DO migration spelling and optional migrations', async t => {
    const config = emitted();
    config.r2_buckets = [{binding:'FILES',bucket_name:'source-files'}];
    config.durable_objects.bindings = [{name:'CONVERSATIONS',class_name:'ConversationSocket'}];
    config.migrations = [{tag:'v1',new_sqlite_classes:['ConversationSocket']},{tag:'v2',new_classes:['Old'],deleted_classes:['Retired'],renamed_classes:[{from:'Old',to:'New'}],transferred_classes:[{from:'External',from_script:'source-worker',to:'Local'}]}];
    config.queues.producers.push({binding:'JOBS_DEAD_LETTER',queue:'dead'});
    config.queues.consumers = [{queue:'reference-jobs',max_batch_size:1,max_retries:0,dead_letter_queue:'dead'}];
    config.vars = {APP_ORIGIN:'https://example.test'};
    const root = await project(t,config);
    const spec = await deploymentSpec(root,{...policy,migrationPrefix:'core-',publicVariableNames:['APP_ORIGIN'],optionalSecretNames:['MAIL_KEY'],extraMigrationDirectories:[{binding:'DB',path:resolve(root,'migrations/ext'),prefix:'ext-',optional:true}]});
    assert.deepEqual(spec.resources,[{kind:'d1',binding:'DB'},{kind:'r2',binding:'FILES'},{kind:'queue',binding:'JOBS'},{kind:'queue',binding:'JOBS_DEAD_LETTER'}]);
    assert.equal(spec.migrations[0].name,'core-001.sql');
    assert.deepEqual(spec.durableObjectMigrations[1],{tag:'v2',newSqliteClasses:[],newClasses:['Old'],deletedClasses:['Retired'],renamedClasses:[{from:'Old',to:'New'}],transferredClasses:[{from:'External',fromScript:'source-worker',to:'Local'}]});
    assert.equal(spec.queueConsumers[0].maxRetries,0);
    assert.equal(spec.queueConsumers[0].deadLetterBinding,'JOBS_DEAD_LETTER');
  });

  await step('migration hashes preserve BOM, CRLF and code-unit filename order', async t => {
    const root = await project(t);
    const bytes = Buffer.from('\ufeff-- retained bytes\r\nCREATE TABLE crlf(id INTEGER);\r\n');
    await writeFile(join(root,'migrations/core/Z.sql'),bytes);
    await writeFile(join(root,'migrations/core/a.sql'),'-- lower\n');
    const first = await deploymentSpec(root,policy), second = await deploymentSpec(root,policy);
    assert.equal(JSON.stringify(first),JSON.stringify(second));
    assert.deepEqual(first.migrations.map(row => row.name),['001.sql','Z.sql','a.sql']);
    assert.equal(first.migrations[1].sha256,hash(bytes));
    assert.deepEqual(Buffer.from(first.migrations[1].sql),bytes);
  });

  await step('UTF-8 corruption and migration authority cannot be packaged', async t => {
    const root = await project(t);
    for (const bytes of [Buffer.from([0xff]),Buffer.from('CREATE TABLE rer_migrations(id);')]) {
      await writeFile(join(root,'migrations/core/001.sql'),bytes);
      await assert.rejects(deploymentSpec(root,policy),/UTF-8|migration authority/);
    }
  });

  await step('migration roots, duplicate identity and optional semantics are enforced', async t => {
    const root = await project(t);
    for (const options of [
      {extraMigrationDirectories:[{binding:'DB',path:'missing'}]},
      {extraMigrationDirectories:[{binding:'UNKNOWN',path:'missing',optional:true}]},
      {extraMigrationDirectories:[{binding:'DB',path:'../outside',optional:true}]},
      {extraMigrationDirectories:[{binding:'DB',path:'migrations/core'}]},
      {extraMigrationDirectories:[{binding:'DB',path:'missing',optional:'yes'}]},
      {extraMigrationDirectories:[{binding:'DB',path:'.env/sql',optional:true}]},
      {migrationPrefix:'../'},
    ]) await assert.rejects(deploymentSpec(root,{...policy,...options}));
    await symlink(join(root,'migrations/core'),join(root,'linked'));
    await assert.rejects(deploymentSpec(root,{...policy,extraMigrationDirectories:[{binding:'DB',path:'linked',optional:true}]}),/symlink/);
    await symlink(join(root,'migrations/core/001.sql'),join(root,'migrations/core/linked.sql'));
    await assert.rejects(deploymentSpec(root,policy),/regular SQL/);
  });

  await step('Wrangler input must be real, contained, regular JSON and not a symlink', async t => {
    const root = await project(t);
    await writeFile(join(root,'dist/server/invalid.json'),'{bad');
    await symlink(join(root,'dist/server/wrangler.json'),join(root,'linked.json'));
    for (const wranglerFile of ['../outside.json','linked.json','dist/server','dist/server/invalid.json','.env']) await assert.rejects(deploymentSpec(root,{...policy,wranglerFile}));
    await assert.rejects(deploymentSpec(root,{...policy,wranglerFile:'wrangler.toml'}),/ENOENT/);
  });

  await step('all three email recipient modes retain independent sender restrictions', async t => {
    const config = emitted();
    config.send_email = [{name:'UNRESTRICTED'},{name:'FIXED',destination_address:'dest@example.test',allowed_sender_addresses:['sender@example.test']},{name:'LIST',allowed_destination_addresses:['one@example.test','two@example.test']}];
    const root = await project(t,config);
    const spec = await deploymentSpec(root,policy);
    assert.deepEqual(spec.emailSending,[{binding:'UNRESTRICTED'},{binding:'FIXED',destinationAddress:'dest@example.test',allowedSenderAddresses:['sender@example.test']},{binding:'LIST',allowedDestinationAddresses:['one@example.test','two@example.test']}]);
    assert(!spec.resources.some(row => row.binding === 'FIXED'));
    assert.equal(portableResourceCapability(spec).complete,true);
  });

  await step('malformed or unknown email restrictions never become unrestricted', async t => {
    const root = await project(t);
    for (const item of [
      {name:'EMAIL',destination_address:'a@example.test',allowed_destination_addresses:['b@example.test']},
      {name:'EMAIL',allowed_destination_addresses:[]}, {name:'EMAIL',allowed_sender_addresses:[]},
      {name:'EMAIL',allowed_destination_addresses:['a@example.test','a@example.test']},
      {name:'EMAIL',allowed_sender_addresses:null}, {name:'EMAIL',destination_address:null},
      {name:'EMAIL',destination_address:'a@example.test\r\nBcc:x@example.test'},
      {name:'EMAIL',allowed_destination_address:'a@example.test'}, {name:'EMAIL',future_restriction:true},
      {name:'lowercase'}, {name:'DB'}, {name:'ASSETS'},
    ]) { const config = emitted(); config.send_email = [item]; await save(root,config); await assert.rejects(deploymentSpec(root,policy)); }
    const config = emitted(); config.send_email = [{name:'EMAIL'},{name:'EMAIL'}]; await save(root,config);
    await assert.rejects(deploymentSpec(root,policy),/Duplicate/);
  });

  await step('KV and Analytics are native resources with explicitly incomplete data portability', async t => {
    const config = emitted();
    config.kv_namespaces = [{binding:'CACHE',id:'source-kv'}]; config.analytics_engine_datasets = [{binding:'EVENTS',dataset:'source-events'}];
    config.durable_objects.bindings = [{name:'ROOMS',class_name:'Room'}];
    const root = await project(t,config), spec = await deploymentSpec(root,policy);
    assert.deepEqual(spec.resources.slice(-2),[{kind:'kv',binding:'CACHE'},{kind:'analytics_engine',binding:'EVENTS'}]);
    const capability = portableResourceCapability(spec);
    assert.equal(capability.complete,false);
    assert.deepEqual(capability.unsupportedResources.map(row => row.kind),['kv','analytics_engine','durable_object']);
    assert.deepEqual(capability.retainedProviderData.map(row => row.binding),['EVENTS']);
    assert.throws(() => assertPortableResourceSupport(spec),/CACHE.*EVENTS.*ROOMS/);
  });

  await step('unsupported native blocks, unknown future fields and erased nested options fail explicitly', async t => {
    const root = await project(t);
    for (const [field,value] of [
      ['services',[{binding:'SERVICE',service:'other'}]],['ai',{binding:'AI'}],['browser',{binding:'BROWSER'}],
      ['unsafe',{bindings:[{name:'X',type:'secret_text'}]}],['logfwdr',{bindings:[{name:'LOG'}]}],
      ['future_bindings',[]],['assets',{binding:'OTHER'}],['durable_objects',{bindings:[{name:'DO',class_name:'Room',script_name:'other'}]}],
      ['d1_databases',[{binding:'DB',migrations_dir:'../../migrations/core',unknown_restriction:true}]],
      ['queues',{producers:[{binding:'JOBS',queue:'q'}],consumers:[{queue:'q',max_concurrency:1}]}],
      ['queues',{producers:[{binding:'JOBS',queue:'q',delivery_delay:30}]}],
      ['triggers',{crons:[],unknown:true}],['migrations',[{tag:'v1',future_classes:['X']}]],
    ]) { const config = emitted(); config[field] = value; await save(root,config); await assert.rejects(deploymentSpec(root,policy),/Unsupported|External/); }
  });

  await step('binding namespace and queue limits are validated before a candidate is returned', async t => {
    const root = await project(t);
    for (const mutate of [
      c => {c.r2_buckets = [{binding:'DB',bucket_name:'other'}];},
      c => {c.vars = {APP_ORIGIN:'https://example.test'};},
      c => {c.compatibility_date = '2026-02-30';},
      c => {c.compatibility_flags = null;},
      c => {c.queues.consumers[0].max_batch_size = null;},
      c => {c.queues.consumers[0].max_retries = -1;},
      c => {c.queues.consumers[0].dead_letter_queue = 'reference-jobs';},
      c => {c.queues.consumers[0].queue = 'unknown';},
      c => {c.queues.producers.push({binding:'OTHER',queue:'reference-jobs'});},
    ]) { const config = emitted(); mutate(config); await save(root,config); await assert.rejects(deploymentSpec(root,policy)); }
    await save(root,emitted());
    await assert.rejects(deploymentSpec(root,{...policy,secretNames:['DB']}),/Conflicting/);
    await assert.rejects(deploymentSpec(root,{...policy,secretNames:['KEY'],optionalSecretNames:['KEY']}),/Conflicting/);
  });

  await step('duplicate JSON keys cannot erase bindings or recipient restrictions', async t => {
    const root = await project(t);
    for (const text of [
      '{"send_email":[{"name":"EMAIL","destination_address":"a@example.test"}],"send_email":[]}',
      '{"send_email":[{"name":"EMAIL","allowed_sender_addresses":["a@example.test"],"allowed_sender_addresses":null}]}',
      '{"send_email":[],"send_\\u0065mail":[]}',
    ]) {
      await writeFile(join(root,'dist/server/wrangler.json'),text);
      await assert.rejects(deploymentSpec(root,policy),/Duplicate Wrangler JSON field/);
    }
    const config = emitted(); config.vars = {QUOTE:'a"b\\c[]{}'}; await save(root,config);
    assert.equal((await deploymentSpec(root,{...policy,publicVariableNames:['QUOTE']})).publicVariables.QUOTE,config.vars.QUOTE);
  });
})











test('direct candidate schema validation rejects unknown fields and altered hashes', async t => {
  const root = await project(t), spec = await deploymentSpec(root,policy);
  for (const mutate of [
    s => {s.schema = 2;},s => {s.resources[0].id = 'provider-id';},s => {s.unknown = true;},
    s => {s.migrations[0].sql += '\n';},s => {s.publicVariables.JOBS = 'conflict';},
    s => {s.emailSending = [{binding:'EMAIL',allowedDestinationAddresses:['x@example.test'],unknown:true}];},
    s => {s.durableObjectMigrations = [{tag:'v1',newSqliteClasses:[null]}];},
    s => {s.queueConsumers[0].extra = true;},
  ]) { const invalid = structuredClone(spec); mutate(invalid); assert.throws(() => validateCandidateSpec(invalid)); }
});
