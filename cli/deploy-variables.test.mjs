import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { exportReference } from '../scripts/export-reference.mjs';

const base = resolve(import.meta.dirname, '..');

// One public door: the exported seed and real CLI, without installing tools,
// executing a build, or substituting an implementation of the check.
test('rer check reports every plain var / deploy secret overlap before a build', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-check-vars-')), root = join(directory, 'seed');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await exportReference(base, root);
 const run = (...args) => spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), 'check', '--cwd', root, ...args], {
  encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: process.env.HOME, RER_NO_UPDATE_CHECK: '1' },
 });
 const check = () => {
  const result = run('--json');
  assert.equal(result.signal, null, result.stderr);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(report.event, 'result');
  return { ...result, report, clause: report.clauses.find(clause => clause.id === 'deploy.vars-secrets') };
 };
 const configPath = join(root, 'wrangler.jsonc'), original = await readFile(configPath, 'utf8');
 const config = JSON.parse(original);
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 declaration.secrets.push({ binding: 'ANOTHER_SECRET', environment: 'OTHER_INPUT' });
 await writeFile(join(root, 'deploy.json'), JSON.stringify(declaration, null, 2) + '\n');
 const clean = check();
 assert.equal(clean.status, 0, clean.stdout + clean.stderr);
 assert.deepEqual(clean.clause, { id: 'deploy.vars-secrets', ok: true });

 // Only a var, only a secret, and an unrelated nested key named vars pass.
 await writeFile(configPath, JSON.stringify({ ...config, vars: { PUBLIC_LABEL: '', PUBLIC_NUMBER: 42 }, metadata: { vars: { OWNER_EMAIL: '' } } }));
 assert.equal(check().status, 0);
 const source = original.trimEnd().slice(0, -1) + `,
  // An empty placeholder is still a plain var; comments are not declarations.
  // "OWNER_EMAIL": "comment only"
  "vars": {
    "OWNER_EMAIL": "",
    "PUBLIC_LABEL": "public",
  },
  "env": {
    "preview": { "vars": { "ANOTHER_SECRET": "synthetic-overlap-value" } },
    "production": {
      "vars": { "OWNER_\\u0045MAIL": "" }
    }
  },
}
`;
 await writeFile(configPath, source);
 const failed = check();
 assert.equal(failed.status, 1, failed.stdout + failed.stderr);
 assert.equal(failed.report.ok, false);
 assert.equal(failed.clause.ok, false);
 assert.deepEqual(failed.report.clauses.filter(clause => !clause.ok).map(clause => clause.id), ['deploy.vars-secrets']);
 const line = (text, needle) => text.slice(0, text.indexOf(needle)).split('\n').length;
 const deploySource = await readFile(join(root, 'deploy.json'), 'utf8');
 for (const [binding, needle] of [['OWNER_EMAIL', '"OWNER_EMAIL": ""'], ['ANOTHER_SECRET', '"ANOTHER_SECRET": "synthetic'], ['OWNER_EMAIL', '"OWNER_\\u0045MAIL"']]) {
  assert.ok(failed.clause.message.includes(`${binding}: wrangler.jsonc:${line(source, needle)}`), failed.clause.message);
  assert.ok(failed.clause.message.includes(`deploy.json:${line(deploySource, '"binding": "' + binding + '"')}`), failed.clause.message);
 }
 assert.equal(failed.clause.message.split('\n').length, 4, 'all three declarations and one repair line');
 assert.match(failed.clause.message, /remove it from wrangler vars; the deploy sets it as a secret/);
 assert.ok(!failed.clause.message.includes('synthetic-overlap-value'), 'values stay out of diagnostics');
 const human = run();
 assert.equal(human.status, 1);
 assert.ok(human.stdout.includes('deploy.vars-secrets: ' + failed.clause.message), human.stdout);

 // Additional deploy templates are checked even when the root is clean.
 await writeFile(configPath, original);
 await mkdir(join(root, 'deploy'));
 await writeFile(join(root, 'deploy/wrangler.template.json'), '{\n  "env": {"other": {"vars": {"ANOTHER_SECRET": ""}}}\n}\n');
 const template = check();
 assert.equal(template.status, 1);
 assert.match(template.clause.message, /ANOTHER_SECRET: deploy\/wrangler.template.json:2/);
 await rm(join(root, 'deploy/wrangler.template.json'));
 await writeFile(join(root, 'deploy/wrangler.template.toml'), `# OWNER_EMAIL = "comment"
[env.preview.vars]
"OWNER_EMAIL" = ""
ANOTHER_SECRET = "synthetic-toml-value"
[env.production]
vars = {
  ANOTHER_SECRET = ""
}
[vars.OWNER_EMAIL]
public = true
`);
 const toml = check();
 assert.equal(toml.status, 1);
 for (const [binding, line] of [['OWNER_EMAIL', 3], ['ANOTHER_SECRET', 4], ['ANOTHER_SECRET', 7], ['OWNER_EMAIL', 9]]) {
  assert.ok(toml.clause.message.includes(`${binding}: deploy/wrangler.template.toml:${line}`), toml.clause.message);
 }
 await rm(join(root, 'deploy/wrangler.template.toml'));

 // Respect the adapter's actual deployment declaration and custom config.
 const adapterPath = join(root, 'scripts/installer/local.mjs');
 const adapter = await readFile(adapterPath, 'utf8');
 await writeFile(adapterPath, adapter.replace("ownerDeploy('deploy.json'", "ownerDeploy('config/owner.json'").replace("devIdentity: { entry:", "devIdentity: { deployConfig: 'config/worker.jsonc', entry:"));
 await mkdir(join(root, 'config'));
 await writeFile(join(root, 'config/owner.json'), JSON.stringify({ secrets: [{ binding: 'CUSTOM_SECRET', environment: 'CUSTOM_INPUT' }] }, null, 2));
 await writeFile(join(root, 'config/worker.jsonc'), '{\n "vars": { "CUSTOM_SECRET": "" }, "main": "src/server.ts"\n}');
 const custom = check();
 assert.equal(custom.status, 1);
 assert.match(custom.clause.message, /CUSTOM_SECRET: config\/worker.jsonc:2.*config\/owner.json:4/);
 await writeFile(join(root, 'config/worker.jsonc'), '{ "vars": { "PUBLIC_ONLY": "" }, "main": "src/server.ts" }');
 const repaired = check();
 assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);

 // Restoring the source declarations restores the entire seed gate.
 await writeFile(adapterPath, adapter);
 assert.equal(check().status, 0);
});
