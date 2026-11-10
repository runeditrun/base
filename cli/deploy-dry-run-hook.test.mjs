import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main as cli } from './main.mjs';
import { checkout, account } from './fixtures/owner-deploy.mjs';

// A seed whose hook validates its own plan and names a stand-in declaration
// (no `version`), as Lamp does. Only the Cloudflare edge is faked.
async function standIn(t, hookResult) {
 const { root, git } = await checkout(t, { secrets: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ binding: name, environment: name })) });
 account(t);
 const { version: _, ...declaration } = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 await writeFile(join(root, 'hosted-check.json'), JSON.stringify(declaration));
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Owner installation', groups: [], fields: [
  { name: 'OWNER_EMAIL', kind: 'email', label: 'Owner email', required: true, prefill: 'account-email' },
  { name: 'FIRST_OWNER_NAME', kind: 'text', label: 'Your name', required: true },
  ...['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ name, label: name, kind: 'secret', generate: 'hex', required: true, ownerVisible: false }))],
  steps: [{ type: 'owner-claim', mode: 'signed', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN', path: '/auth/bootstrap' }] }));
 const source = path => JSON.stringify(new URL(path, import.meta.url).href);
 await writeFile(join(root, 'adapter.mjs'), `import { localInstaller } from ${source('../onboarding/adapter.mjs')};
import { commandAdapter as declareAdapter } from ${source('./adapter.mjs')};
const lifecycle = localInstaller({secrets:{file:'.dev.vars',keepExisting:true},owner:{displayName:input=>input.FIRST_OWNER_NAME?.trim()||'Owner'}});
const hook = async ({options,store}) => {
 if (!options.dryRun) throw Error('This fixture only dry-runs');
 store.report('hook: dry run complete; the seed validated its own plan.');
 return ${hookResult};
};
export const commandAdapter = declareAdapter(lifecycle,{setup:{manifestFile:'rer-setup.json'},input:{names:{name:'FIRST_OWNER_NAME'}},deployDeclaration:'hosted-check.json',deploy:hook});`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(['setup', 'deploy'].map(verb => [verb, { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'hosted-check.json'], effects: 'Offline fixture.' }])) }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 git('add', '.'); git('commit', '-qm', 'stand-in declaration');
 const saved = { ...process.env };
 process.env.CI = 'true'; process.env.HOME = root;
 t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); });
 return async (...flags) => {
  const output = [], diagnostics = [];
  const out = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const err = t.mock.method(process.stderr, 'write', chunk => { diagnostics.push(String(chunk)); return true; });
  const code = await cli(['deploy', '--dry-run', '--cwd', root, '--json', '--non-interactive', ...flags]).finally(() => { out.mock.restore(); err.mock.restore(); });
  const events = output.join('').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { code, events, result: events.at(-1), error: events.find(event => event.event === 'error')?.message, text: output.join('') + diagnostics.join('') };
 };
}

const completions = text => text.split('\n').filter(line => /^deploy: .*dry run complete/.test(line));

test('a dry run does not plan against the stand-in declaration a validated hook names, and prints one completion line', async t => {
 const run = await standIn(t, '{dryRun:true,deployed:false}');
 const dry = await run();
 assert.equal(dry.code, 0, dry.text);
 assert.equal(dry.result.ok, true);
 assert.equal(completions(dry.text).length, 1, dry.text);
 assert.ok(dry.text.indexOf('hook: dry run complete') < dry.text.indexOf('deploy: local dry run complete'), 'rer completes after its hook');
});

test('a dry run whose own plan step fails prints no completion line and names the step, not a deployment record', async t => {
 const run = await standIn(t, "{dryRun:true,deployed:false,state:'hook-state.json'}");
 const dry = await run();
 assert.notEqual(dry.code, 0);
 assert.equal(dry.result.ok, false);
 assert.equal(completions(dry.text).length, 0, dry.text);
 assert.match(dry.error, /Failed at plan the deploy locally: invalid-owner-declaration/);
 assert.doesNotMatch(dry.error, /deployment record/);
});

test('a dry run lists the owner name a real deploy still needs until it is supplied', async t => {
 const run = await standIn(t, '{dryRun:true,deployed:false}');
 const fresh = await run();
 assert.equal(fresh.code, 0, fresh.text);
 assert.match(fresh.result.neededForRealDeploy.join('\n'), /owner name \(--owner-name or rer setup\)/);
 const named = await run('--owner-name', 'Alex Morgan');
 assert.equal(named.code, 0, named.text);
 assert.doesNotMatch((named.result.neededForRealDeploy ?? []).join('\n'), /owner name/);
});
