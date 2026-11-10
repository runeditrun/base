import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkout } from './fixtures/owner-deploy.mjs';

const execute = promisify(execFile);
const rer = fileURLToPath(new URL('../bin/rer.mjs', import.meta.url));

// A seed whose deploy hook validates its own dry-run plan and returns no kit
// state, naming `declaration` as its deployDeclaration (Lamp names a stand-in).
// With `named`, its installer asks for an owner name, as Lamp's does.
async function seed(t, { declaration, named = false }) {
 const { root, git } = await checkout(t, {});
 const source = path => JSON.stringify(new URL(path, import.meta.url).href);
 await writeFile(join(root, 'stand-in.json'), JSON.stringify(declaration));
 const fields = [{ name: 'OWNER_EMAIL', kind: 'email', label: 'Owner email', required: true, prefill: 'account-email' },
  ...['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ name, label: name, kind: 'secret', generate: 'hex', required: true, ownerVisible: false })),
  { name: 'FIRST_OWNER_NAME', kind: 'text', label: 'Your name', required: true }];
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Owner installation', groups: [], fields, steps: [{ type: 'owner-claim', mode: 'signed', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN', path: '/auth/bootstrap' }] }));
 await writeFile(join(root, 'adapter.mjs'), `import { localInstaller } from ${source('../onboarding/adapter.mjs')};
import { commandAdapter as declareAdapter } from ${source('./adapter.mjs')};
const lifecycle = localInstaller({secrets:{file:'.dev.vars',keepExisting:true},owner:{displayName:input=>input.FIRST_OWNER_NAME?.trim()||'Owner'}});
const hook = async ({options,store}) => {
 if (!options.dryRun) throw Error('This seed fixture only supports offline preflight');
 store.report('deploy: seed hook says dry run complete');
 return {dryRun:true,deployed:false};
};
export const commandAdapter = declareAdapter(lifecycle,{${named ? "setup:{manifestFile:'rer-setup.json'},input:{names:{name:'FIRST_OWNER_NAME'}}," : ''}deployDeclaration:'stand-in.json',deploy:hook});`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'stand-in.json'], effects: 'Preflight the seed deployment offline.' } } }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\n.dev.vars\ndeploy.env\n');
 git('add', '.'); git('commit', '-qm', 'dry run hook seed');
 return root;
}

async function dryRun(root, ...flags) {
 const env = { ...process.env, CI: 'true', HOME: root };
 for (const name of Object.keys(env)) if (/^(CLOUDFLARE_|CF_)/.test(name)) delete env[name];
 let result;
 try { result = { code: 0, ...await execute(process.execPath, [rer, 'deploy', '--dry-run', '--cwd', root, '--json', ...flags], { env }) }; }
 catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
 const events = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
 return { ...result, text: result.stdout + result.stderr, events, receipt: events.findLast(event => event.event === 'result'), error: events.find(event => event.event === 'error') };
}

test('a dry run whose hook returned no kit state does not plan the hook\'s stand-in declaration, and rer says it is complete once', async t => {
 const root = await seed(t, { declaration: { project: 'tests/fixture', vars: {}, d1: [{ binding: 'DB' }] } });
 const run = await dryRun(root);
 assert.equal(run.code, 0, run.text);
 assert.equal(run.receipt.ok, true);
 assert.equal(run.text.match(/deploy: rer dry run complete/g)?.length, 1, run.text);
 assert.ok(run.text.indexOf('seed hook says dry run complete') < run.text.indexOf('deploy: rer dry run complete'), 'rer completes after the hook');
});

test('a failing rer plan after the hook names its step, prints no completion line and does not blame a deployment record', async t => {
 // A kit declaration (version 1) rer plans, with a key no plan accepts.
 const root = await seed(t, { declaration: { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', d1: [{ binding: 'DB' }], unplannable: true } });
 const run = await dryRun(root);
 assert.notEqual(run.code, 0, run.text);
 assert.match(run.error.message, /Failed at plan the dry run: invalid-owner-declaration/);
 assert.doesNotMatch(run.text, /inspect its deployment record/);
 assert.doesNotMatch(run.text, /rer dry run complete/);
 assert.equal(run.receipt.ok, false);
});

test('a dry run lists the owner name a real deploy still needs until one is supplied or held', async t => {
 const root = await seed(t, { declaration: { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', d1: [{ binding: 'DB' }] }, named: true });
 const fresh = await dryRun(root);
 assert.equal(fresh.code, 0, fresh.text);
 assert.match(fresh.receipt.neededForRealDeploy?.join('\n') ?? '', /owner name \(--owner-name or rer setup\)/, fresh.text);
 const named = await dryRun(root, '--owner-name', 'Ada Owner');
 assert.equal(named.code, 0, named.text);
 assert.doesNotMatch(named.receipt.neededForRealDeploy?.join('\n') ?? '', /owner name/);
});
