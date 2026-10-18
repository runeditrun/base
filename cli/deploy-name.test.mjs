import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { main as cli } from './main.mjs';
import { checkout, account } from './fixtures/owner-deploy.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { terminalDeploy } from './fixtures/deploy-terminal.mjs';

// Real setup/dispatcher/deploy lifecycle; only the local and hosted HTTP edge
// and Cloudflare are faked, using the existing owner-account fixture.
test('setup and deploy carry the declared owner name, and unattended deploy refuses an unknown name before upload', async t => {
 for (const custom of [false, true]) for (const nameField of ['displayName', 'FIRST_OWNER_NAME', undefined]) {
  await t.test(`${custom ? 'custom' : 'standard'} deploy / ${nameField ?? 'nameless'}`, async t => {
   const { root, git } = await checkout(t, { secrets: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ binding: name, environment: name })) });
   const { provider, claimBodies } = account(t), localClaims = [];
   const savedEnv = { ...process.env };
   Object.assign(process.env, await isolatedQueue(t), { CI: 'true' });
   t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, key)) delete process.env[key]; Object.assign(process.env, savedEnv); });
   const inner = globalThis.fetch;
   t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === '127.0.0.1' && url.pathname === '/auth/bootstrap') {
     localClaims.push(JSON.parse(init.body)); return new Response(null, { status: 303 });
    }
    return inner(input, init);
   });
   const name = nameField ?? 'displayName';
   const fields = [{ name: 'OWNER_EMAIL', kind: 'email', label: 'Owner email', required: true, prefill: 'account-email' },
    ...['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ name, label: name, kind: 'secret', generate: 'hex', required: true, ownerVisible: false }))];
   if (nameField === 'FIRST_OWNER_NAME') fields.push({ name, kind: 'text', label: 'Your name', required: true });
   await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Owner installation', groups: [], fields, steps: [{ type: 'owner-claim', mode: 'signed', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN', path: '/auth/bootstrap' }] }));
   const source = path => JSON.stringify(new URL(path, import.meta.url).href);
   await writeFile(join(root, 'adapter.mjs'), `import { localInstaller } from ${source('../onboarding/adapter.mjs')};
import { commandAdapter as declareAdapter } from ${source('./adapter.mjs')};
import { ownerDeploy } from ${source('./deploy.mjs')};
import { main as owner } from ${source('../modules/deploy-kit/owner-cli.mjs')};
const lifecycle = localInstaller({secrets:{file:'.dev.vars',keepExisting:true},owner:{displayName:input=>input[${JSON.stringify(name)}]?.trim()||'Owner'}});
export const commandAdapter = declareAdapter(lifecycle,{setup:{manifestFile:'rer-setup.json'},ownerBootstrap:${nameField === 'displayName'},input:{names:{name:${JSON.stringify(name)}}},deployDeclaration:'deploy.json',deploy:${custom ? "async ({root,options})=>({...await owner(['deploy','--declaration','deploy.json','--environment',options.environment??'production'],process.env,{cwd:root}),deployed:true})" : "ownerDeploy('deploy.json',lifecycle)"}});`);
   await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(['setup', 'deploy'].map(verb => [verb, { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: `${verb} the installation.` }])) }));
   await writeFile(join(root, '.node-version'), process.versions.node + '\n');
   await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
   await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\n.dev.vars\n');
   await writeFile(join(root, '.dev.vars'), 'OWNER_EMAIL=owner@example.test\nSESSION_SECRET=local-only-session\nSETUP_TOKEN=test-only-local-token\n', { mode: 0o600 });
   git('add', '.'); git('commit', '-qm', 'owner name installation');
   const run = async (verb, ...flags) => {
    const output = [];
    const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
    const code = await cli([verb, '--cwd', root, '--json', '--non-interactive', ...flags]).finally(() => capture.mock.restore());
    const events = output.join('').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { code, error: events.find(event => event.event === 'error')?.message };
   };
   const answersPath = join(root, '.seed/installer/setup-answers.json');
   if (nameField) {
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const setup = await run('setup', '--host', '127.0.0.1', '--port', String(port), '--owner-name', 'Maya Chen');
    assert.equal(setup.code, 0, setup.error);
    assert.equal(localClaims.at(-1).displayName, 'Maya Chen');
    assert.equal(JSON.parse(await readFile(answersPath, 'utf8'))[name], 'Maya Chen');
   }
   let result = await run('deploy');
   assert.equal(result.code, 0, result.error);
   assert.equal(claimBodies.at(-1).displayName, nameField ? 'Maya Chen' : 'Owner');
   if (!nameField) {
    result = await run('deploy', '--owner-name', 'Maya Chen');
    assert.equal(result.code, 2, 'a nameless installer still rejects the name flag');
    return;
   }
   // Remove the hosted installation through its public door so each assertion
   // observes a fresh bootstrap, using the fixture's single Worker account.
   assert.equal((await run('deploy', '--remove', '--yes')).code, 0);
   await rm(answersPath);
   const writes = provider.state.writes.length, claims = claimBodies.length;
   result = await run('deploy');
   assert.equal(result.code, 3, result.error);
   assert.match(result.error, /--owner-name/);
   assert.equal(result.error.split('\n').length, 1);
   assert.equal(provider.state.writes.length, writes, 'no upload or provider write without a name');
   assert.equal(claimBodies.length, claims);
   for (const invalid of ['\u0001', 'A'.repeat(201)]) {
    assert.equal((await run('deploy', '--owner-name', invalid)).code, 2);
    assert.equal(provider.state.writes.length, writes);
   }
   result = await run('deploy', '--owner-name', ' Alex Morgan ');
   assert.equal(result.code, 0, result.error);
   assert.equal(claimBodies.at(-1).displayName, 'Alex Morgan');
   const saved = JSON.parse(await readFile(answersPath, 'utf8'));
   assert.equal(saved[name], ' Alex Morgan ');
   assert.equal((await run('deploy', '--remove', '--yes')).code, 0);
   result = await run('deploy');
   assert.equal(result.code, 0, result.error);
   assert.equal(claimBodies.at(-1).displayName, 'Alex Morgan', 'later deploys reuse the saved answer');
   if (!custom && nameField === 'displayName') {
    assert.equal((await run('deploy', '--remove', '--yes')).code, 0);
    await rm(answersPath);
    const terminal = await terminalDeploy(t, root);
    assert.deepEqual(await terminal('production'), { code: 0, prompts: 1 });
    assert.equal(claimBodies.at(-1).displayName, 'Noah Patel');
    assert.equal(JSON.parse(await readFile(answersPath, 'utf8'))[name], 'Noah Patel');
    assert.equal((await run('deploy', '--remove', '--yes')).code, 0);
    assert.deepEqual(await terminal('production'), { code: 0, prompts: 0 });
    assert.equal(claimBodies.at(-1).displayName, 'Noah Patel');
   }
  });
 }
});
