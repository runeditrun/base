import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createState } from './state.mjs';
import { localInstaller } from './adapter.mjs';

// A stand-in for `wrangler d1 migrations apply`: it redraws the whole table after
// every migration it applies, as wrangler does, and can fail on one of them.
const wrangler = `
const count = Number(process.env.MIGRATIONS), failAt = Number(process.env.FAIL_AT || 0);
const names = Array.from({ length: count }, (_, i) => String(i + 1).padStart(4, '0') + '_' + 'table_'.repeat(3) + 'part.sql');
const rule = (l, m, r) => l + '─'.repeat(30) + m + '─'.repeat(8) + r;
console.log(' ⛅️ wrangler 4.0.0\\nResource location: local\\n\\nMigrations to be applied:');
console.log(['┌' + '─'.repeat(30) + '┐', '│ name' + ' '.repeat(26) + '│', '├' + '─'.repeat(30) + '┤', ...names.map(n => '│ ' + n.padEnd(28) + ' │'), '└' + '─'.repeat(30) + '┘'].join('\\n'));
for (let i = 0; i < count; i++) {
 console.log('🌀 Executing on local database db (0000) from state:');
 const bad = failAt === i + 1;
 if (!bad) console.log('🚣 ' + (i * 7 + 3) + ' commands executed successfully.');
 // Real wrangler prints no failed row for a SQL error: only the message.
 if (bad && process.env.PLAIN_ERROR) { console.error('✘ [ERROR] near "oops": syntax error at offset 12'); process.exit(1); }
 console.log([rule('┌', '┬', '┐'), '│ name' + ' '.repeat(26) + '│ status │', rule('├', '┼', '┤'), ...names.slice(0, i + 1).map((n, j) => '│ ' + n.padEnd(28) + ' │ ' + (bad && j === i ? '❌' : '✅') + '     │'), rule('└', '┴', '┘')].join('\\n'));
 if (bad) { console.error('✘ [ERROR] near "oops": syntax error at offset 12'); process.exit(1); }
}
`;

async function run(t, env) {
 const root = await mkdtemp(join(tmpdir(), 'migration-progress-'));
 await writeFile(join(root, 'wrangler.js'), wrangler);
 const store = await createState(root, { product: 'Migration progress', model: { safeKeys: ['email'] } });
 t.after(async () => { await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 const kit = localInstaller({ features: {}, tools: [], dependencies: false, secrets: {}, build: false, start: false, owner: false, signIn: false,
  migrate: [process.execPath, ['wrangler.js', 'd1', 'migrations', 'apply', 'db'], { env: { ...process.env, ...env } }] });
 await kit.install(root, { email: 'owner@example.test' }, store, () => {});
 const outcome = store.state.phase === 'failed' ? store.state.error : null;
 return { store, outcome, shown: store.state.logs.join('\n'), log: await readFile(store.logPath, 'utf8') };
}

test('applying many migrations shows a short count while the setup log keeps wrangler\'s full output', async t => {
 const { store, outcome, shown, log } = await run(t, { MIGRATIONS: '75' });
 assert.equal(outcome, null);
 assert.ok(shown.length < 2500, `shown ${shown.length} bytes`);
 assert.match(shown, /Applying migrations 10\/75/);
 assert.match(shown, /Applying migrations 70\/75/);
 assert.match(shown, /Applied 75 migrations\./);
 assert.ok(!shown.includes('commands executed'));
 assert.ok(shown.split('\n').length < 25);
 assert.equal(store.state.migrationsApplied, 75);
 assert.ok(log.length > 100000, 'the log keeps every table');
 assert.equal(log.split('0001_table_table_table_part.sql').length - 1, 76);
});

test('a failing migration still names itself, prints the tool\'s error and the log path', async t => {
 const { store, outcome, shown } = await run(t, { MIGRATIONS: '30', FAIL_AT: '17' });
 assert.ok(outcome, 'the step fails');
 const message = outcome;
 for (const text of [message, shown]) {
  assert.match(text, /Migration 0017_table_table_table_part\.sql failed\./);
  assert.match(text, /syntax error at offset 12/);
 }
 assert.ok(message.length < 3000, `message ${message.length} bytes`);
 assert.ok(message.includes(store.logPath) || /Log:|Full log:/.test(message));
});

test('an error wrangler does not tie to a migration is tied to the first one that never finished', async t => {
 const { outcome, shown } = await run(t, { MIGRATIONS: '30', FAIL_AT: '17', PLAIN_ERROR: '1' });
 assert.ok(outcome, 'the step fails');
 for (const text of [outcome, shown]) {
  assert.match(text, /Migration 0017_table_table_table_part\.sql failed\./);
  assert.match(text, /syntax error at offset 12/);
 }
});
