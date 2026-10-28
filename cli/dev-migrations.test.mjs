import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixtures/reference.mjs';
import { devEntryBrowser } from './fixtures/dev-entry-browser.mjs';

const events = child => child.stdoutText.trim().split('\n').filter(Boolean).map(JSON.parse);

test('install fetches no browser, setup lists what hosting needs, and dev applies newly pulled canonical migrations before serving and stops on a migration error', { timeout: 20 * 60_000 }, async t => {
 const f = await fixture('default-seed', t);
 // The test browser downloads on first need (verify), never during install.
 const browsers = join(f.root, '..', 'browsers-before-verify');
 await mkdir(browsers);
 const installed = f.launch(['scripts/rer.mjs', 'install', '--json'], process.execPath, { PLAYWRIGHT_BROWSERS_PATH: browsers });
 assert.equal(await installed.done, 0, installed.stderrText.slice(-2000));
 assert.deepEqual(await readdir(browsers), [], 'install downloads no browser');
 // Setup ends by naming what a hosted deploy will still need, from deploy.json.
 const setupReady = events(await f.run(['setup', '--owner-email', 'migration-owner@example.test', '--non-interactive', '--json'])).find(event => event.event === 'setup-ready');
 assert.ok(setupReady?.neededForDeploy?.some(item => item.includes('CLOUDFLARE_API_TOKEN')), JSON.stringify(setupReady));
 assert.ok(setupReady.neededForDeploy.some(item => item.includes('MAIL_API_KEY (or RESEND_API_KEY)')), JSON.stringify(setupReady));
 await f.sql("CREATE TABLE saved_before_upgrade(value TEXT); INSERT INTO saved_before_upgrade VALUES('owner content')");
 const path = join(f.root, 'migrations/core/9998_local_upgrade.sql');
 // Simulate git pull after setup: the old build cannot know this migration.
 await writeFile(path, "CREATE TABLE local_upgrade(value TEXT); INSERT INTO local_upgrade VALUES('applied');\n");
 const settings = await readFile(join(f.root, '.dev.vars'));
 let ready;
 try {
  ready = events(await f.run(['dev', '--detach', '--json'])).find(event => event.event === 'ready');
  assert.ok(ready);
  assert.equal((await fetch(ready.url + '/health')).status, 200);
  assert.deepEqual((await f.sql('SELECT value FROM local_upgrade'))[0].results, [{ value: 'applied' }]);
  assert.deepEqual((await f.sql('SELECT value FROM saved_before_upgrade'))[0].results, [{ value: 'owner content' }]);
  assert.deepEqual((await f.sql("SELECT name FROM d1_migrations WHERE name='9998_local_upgrade.sql'"))[0].results, [{ name: '9998_local_upgrade.sql' }]);
  const capture = await readFile(join(f.root, '.seed/installer/install.log'), 'utf8');
  assert.ok(capture.split('\n').some(line => line.includes('Applied local migrations:') && line.includes('9998_local_upgrade.sql')), 'startup names the applied migration');
  await devEntryBrowser(ready);
  // rer dev --as takes anyone in the local database by email; an unknown email names the people it takes.
  await f.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('local-member','jordan@example.test','Jordan','member','active',1)");
  assert.equal(events(await f.run(['dev', '--as', 'jordan@example.test', '--json'])).find(event => event.event === 'ready')?.signedInAs, 'jordan@example.test');
  // Someone added at a built-in persona's address is signed in by that email, as the person they are.
  await f.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('local-ada','admin@dev.localhost','Ada','member','active',1)");
  assert.equal(events(await f.run(['dev', '--as', 'admin@dev.localhost', '--json'])).find(event => event.event === 'ready')?.signedInAs, 'admin@dev.localhost');
  const unknown = events(await f.run(['dev', '--as', 'nobody@example.test', '--json'], 2)).find(event => event.event === 'error')?.message;
  assert.match(unknown, /nobody@example\.test[^]*owner \(migration-owner@example\.test\)[^]*jordan@example\.test/);
  await f.run(['dev', '--stop', '--json']);
  const repeated = events(await f.run(['dev', '--detach', '--json'])).find(event => event.event === 'ready');
  assert.equal((await fetch(repeated.url + '/health')).status, 200, 'an up-to-date database starts without reapplying SQL');
 } finally {
  // A detached server outlives its CLI, including when an assertion fails.
  await f.run(['dev', '--stop', '--json']);
 }
 assert.deepEqual(await readFile(join(f.root, '.dev.vars')), settings);

 await writeFile(join(f.root, 'migrations/core/9999_broken_upgrade.sql'), 'INSERT INTO missing_upgrade_table VALUES (1);\n');
 const failed = events(await f.run(['dev', '--foreground', '--json'], 1));
 assert.ok(!failed.some(event => event.event === 'ready'));
 const message = failed.find(event => event.event === 'error')?.message;
 assert.match(message, /missing_upgrade_table/);
 assert.match(message, /rer setup/);
 await assert.rejects(fetch(ready.url + '/health'), 'failed migration never serves the app');
 assert.deepEqual((await f.sql("SELECT name FROM d1_migrations WHERE name='9999_broken_upgrade.sql'"))[0].results, []);
});
