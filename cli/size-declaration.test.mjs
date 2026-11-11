import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportReference } from '../scripts/export-reference.mjs';

const base = resolve(import.meta.dirname, '..');
const example = JSON.parse(await readFile(join(base, 'cli/size/examples/happytohelp.json'), 'utf8'));

// One public door: the exported seed and the real `rer check --json`. Only clause ids are asserted.
test('rer check validates size-check.json as SC-15.size.*', { timeout: 5 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-size-declaration-')), root = join(directory, 'seed');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await exportReference(base, root);
 // The example's minute-tick flow needs a cron the checkout declares.
 const wrangler = join(root, 'wrangler.jsonc'), deploy = join(root, 'deploy.json');
 await writeFile(wrangler, (await readFile(wrangler, 'utf8')).replace('*/10 * * * *', '* * * * *'));
 await writeFile(deploy, (await readFile(deploy, 'utf8')).replace('*/10 * * * *', '* * * * *'));
 const file = join(root, 'size-check.json');
 const check = async declaration => {
  if (declaration === undefined) await rm(file, { force: true });
  else await writeFile(file, JSON.stringify(declaration, null, 1) + '\n');
  const result = spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), 'check', '--cwd', root, '--json'], {
   encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, RER_NO_UPDATE_CHECK: '1' },
  });
  assert.equal(result.signal, null, result.stderr);
  const clauses = JSON.parse(result.stdout.trim().split('\n').at(-1)).clauses.filter(clause => clause.id.startsWith('SC-15.size.'));
  return { passing: clauses.filter(clause => clause.ok).map(clause => clause.id), failing: clauses.filter(clause => !clause.ok) };
 };
 const mutate = change => { const copy = structuredClone(example); change(copy); return copy; };
 const flow = (declaration, name) => declaration.flows.find(item => item.name === name);
 const table = (declaration, name) => declaration.shape.tables.find(item => item.table === name);

 assert.deepEqual(await check(undefined), { passing: ['SC-15.size.undeclared'], failing: [] });
 assert.deepEqual(await check(example), { passing: ['SC-15.size.declaration'], failing: [] });

 const mutations = {
  'a misspelled key': [d => { const item = flow(d, 'inbox-list'); item.ceilling = item.ceiling; delete item.ceiling; }, 'SC-15.size.flows.inbox-list.ceilling'],
  'an undeclared persona': [d => { flow(d, 'inbox-list').persona = 'nobody'; }, 'SC-15.size.flows.inbox-list.persona'],
  'an undeclared cron': [d => { flow(d, 'minute-tick').scheduled = '*/7 * * * *'; }, 'SC-15.size.flows.minute-tick.scheduled'],
  'a histogram that does not sum to rows': [d => { table(d, 'knowledge_reply_blocks').rows += 1; }, 'SC-15.size.shape.tables.knowledge_reply_blocks.parent.histogram'],
  'a ceiling over the window budget': [d => { Object.assign(flow(d, 'open-worst-conversation'), { ceiling: 2_000_000, callsInRow: 3 }); }, 'SC-15.size.flows.open-worst-conversation.ceiling'],
  'growth allowed without a why': [d => { flow(d, 'inbox-list').growth = { allowed: true }; }, 'SC-15.size.flows.inbox-list.growth.why'],
  'a duplicate flow name': [d => { d.flows[1].name = 'inbox-list'; }, 'SC-15.size.flows.inbox-list.name'],
  'a semicolon inside an expression': [d => { table(d, 'contacts').values.name = "'a'; DELETE FROM contacts"; }, 'SC-15.size.shape.tables.contacts.values.name'],
  'a parent listed after its child': [d => { const tables = d.shape.tables, [contacts] = tables.splice(tables.findIndex(item => item.table === 'contacts'), 1); tables.splice(tables.findIndex(item => item.table === 'conversations') + 1, 0, contacts); }, 'SC-15.size.shape.tables.conversations.parent.table'],
 };
 for (const [label, [change, id]] of Object.entries(mutations)) {
  const { passing, failing } = await check(mutate(change));
  assert.ok(failing.some(clause => clause.id === id), `${label}: expected ${id}, got ${JSON.stringify(failing.map(clause => clause.id))}`);
  assert.deepEqual(passing, [], label);
  assert.ok(failing.find(clause => clause.id === id).message.includes(id.slice('SC-15.size.'.length)), `${label}: the failure names its field path`);
 }
});
