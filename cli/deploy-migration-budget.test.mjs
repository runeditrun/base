import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deployProviderFixture } from './fixtures/deploy-provider.mjs';

async function deployFixture(t) {
 const {root, provider, run} = await deployProviderFixture(t, {d1:[{binding:'DB'}],r2:[],vars:{MAIL_PROVIDER:'resend',MAIL_FROM:'owner@example.test',MAIL_API_KEY:'test-only-outbound-key'}});
 const names = [];
 for (let index = 1; index <= 128; index++) {
  const name = `${String(index).padStart(4, '0')}_schema.sql`;
  names.push(name);
  await writeFile(join(root, 'migrations/core', name), `CREATE TABLE entry_${index}(id TEXT PRIMARY KEY);`);
 }
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], {cwd:root,stdio:'pipe'});
 git('add', '.'); git('commit', '-qm', 'migration deployment fixture');
 const deploy = async () => {
  const output = [];
  const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const code = await run().finally(() => capture.mock.restore());
  const events = output.flatMap(text => text.trim().split('\n')).filter(Boolean).map(text => JSON.parse(text));
  return {code, error:events.find(event => event.event === 'error')?.message ?? ''};
 };
 return {root, provider, names, deploy};
}

test('rer deploy applies a fresh migration history beyond the fixed provider budget and repeats without writes', async t => {
 const {root, provider, names, deploy} = await deployFixture(t);
 const first = await deploy();
 assert.equal(first.code, 0, first.error);
 const {db} = provider.state.databases[0];
 const rows = db.prepare('SELECT name, state FROM d1_migrations ORDER BY id').all();
 assert.deepEqual(rows.map(row => row.name), names);
 assert.ok(rows.every(row => row.state === 'applied'));
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='entry_128'").get(), 'the final migration executed');
 const statePath = join(root, '.rer/deploy/production.json'), state = await readFile(statePath);
 const saved = JSON.parse(state);
 assert.equal(saved.receipt.provider.versionId, provider.state.version.id);
 assert.equal(saved.receipt.migrations[0].applied.length, names.length);
 const writes = provider.state.writes.length;
 const repeated = await deploy();
 assert.equal(repeated.code, 0, repeated.error);
 assert.equal(provider.state.writes.length, writes, 'an unchanged repeat makes no provider writes');
 assert.deepEqual(await readFile(statePath), state, 'the completed ownership record is retained');
});

test('rer deploy still exhausts a finite request budget when provider listing restarts never settle', async t => {
 const {provider, deploy} = await deployFixture(t), inner = globalThis.fetch;
 let pages = 0;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input);
  if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/d1/database') && (init.method ?? 'GET') === 'GET') {
   pages++;
   const page = Number(url.searchParams.get('page'));
   // Distinct rows and pages keep pagination moving until the last page exposes
   // a missing row. Owner reconciliation restarts that incomplete snapshot.
   return Response.json({success:true,result:[{uuid:randomUUID(),name:`foreign-${pages}`}],result_info:{page,per_page:100,total_pages:99,total_count:100}});
  }
  return inner(input, init);
 });
 const result = await deploy();
 assert.equal(result.code, 1);
 assert.match(result.error, /provider-request-budget/);
 assert.ok(pages > 99, 'the incomplete listing was restarted');
 assert.ok(pages < 2000, 'a looping provider is bounded across restarts');
 assert.equal(provider.state.writes.length, 0, 'a partial inventory never authorizes creation');
});
