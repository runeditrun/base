import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

// Wrangler redraws its whole migration table after every migration. After
// `rer reset --yes`, `rer import` applies every migration again, so a seed
// with a long history printed the table once per migration (a seed-owned
// portability adapter, which runs the command without WRANGLER_LOG=warn,
// printed 2.3 MB over 20,000 lines). The shared runner now gives every such
// command a count, whoever runs it, and keeps wrangler's full output in its log.
const extra = Number(process.env.IMPORT_OUTPUT_EXTRA_MIGRATIONS ?? 53);
const size = result => { const text = result.stdout + result.stderr; return `${Buffer.byteLength(text)} bytes over ${text.split('\n').length - 1} lines`; };

async function history(t, { seedOwned = false } = {}) {
 const seed = await portabilityFixture(t, { generated: false });
 if (seedOwned) {
  // A seed's own adapter runs the same command with wrangler's default logging.
  const adapter = join(seed.root, 'scripts/base-cli/cli/portability.mjs'), source = await readFile(adapter, 'utf8');
  await writeFile(adapter, source.replace(", WRANGLER_LOG: 'warn'", ''));
 }
 for (let n = 1; n <= extra; n++) await writeFile(join(seed.root, `migrations/core/05${String(n).padStart(3, '0')}_history.sql`), `-- history ${n}\nSELECT ${n};\n`);
 await seed.run(['export', '--output', 'exports/empty.rer']);
 await seed.data("INSERT INTO people(id,name,email,created_at) VALUES('clinic','Maya Chen','maya@cedargrove.example','2026-11-13'),('studio','Leo Martinez','leo@northstar.example','2026-11-13')");
 await seed.run(['export', '--output', 'exports/history.rer']);
 if(seedOwned){
  // Orbit rebuilds its search index through a real post-restore Wrangler SQL
  // command. Exercise that same adapter boundary, without replacing the app.
  const adapter=join(seed.root,'scripts/installer/local.mjs');
  await writeFile(adapter,await readFile(adapter,'utf8')+`\nconst native=commandAdapter.portability;
commandAdapter.portability={...native,async import(context){
 const receipt=await native.import(context);
 await context.store.run('Optimizing restored search','pnpm',['exec','wrangler','d1','execute','default-seed-reference','--local','--persist-to','.wrangler/state','--config','wrangler.jsonc','--command','PRAGMA optimize'],{cwd:context.root,signal:context.signal,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 return receipt;
}};\n`);
 }
 await seed.run(['reset', '--yes']);
 return seed;
}

async function boundedImport(t, seed) {
 const imported = await seed.text(['import', '--input', 'exports/history.rer', '--yes']), shown = imported.stdout + imported.stderr;
 t.diagnostic(`rer import --target local after rer reset: ${size(imported)}`);
 console.log(`IMPORT-OUTPUT ${extra} extra migrations: ${size(imported)}${shown.length < 6000 ? `\n${shown}` : ''}`);
 assert.ok(shown.length < 6000, `import printed ${shown.length} bytes`);
 assert.ok(shown.split('\n').length < 80, `import printed ${shown.split('\n').length} lines`);
 assert.match(shown, /Applying migrations 10\/\d+/);
 assert.match(shown, /Applied \d+ migrations\. Full output: \S*install\.log/);
 assert.ok(!shown.includes('Migrations to be applied'));
 assert.doesNotMatch(shown,/Executing on local database|"results"\s*:|"meta"\s*:|commands? executed successfully/);
 const manifest=JSON.parse((await readFile(join(seed.root,'exports/history.rer'),'utf8')).split('\n')[0]);
 const rows=manifest.tables.reduce((sum,table)=>sum+table.count,0);
 assert.match(shown,new RegExp(`${manifest.tables.length} tables, ${rows} rows`),'completion counts describe the actual archive');
 assert.match(shown,/Next:.*rer setup.*rer dev/);
 assert.deepEqual((await seed.data('SELECT name FROM people ORDER BY id'))[0].results,[{name:'Maya Chen'},{name:'Leo Martinez'}]);
 return shown;
}

test('rer import shows migration progress, and a failing migration names itself, its error and the log', { timeout: 15 * 60_000 }, async t => {
 const seed = await history(t);
 await boundedImport(t, seed);
 await seed.run(['reset', '--yes']);
 await writeFile(join(seed.root, 'migrations/core/0999_broken.sql'), 'THIS IS NOT SQL;\n');
 const failed = await seed.text(['import', '--input', 'exports/history.rer', '--yes'], 1), message = failed.stdout + failed.stderr;
 t.diagnostic(`failing import: ${size(failed)}`);
 assert.match(message, /Migration 0999_broken\.sql failed\./);
 assert.match(message, /syntax error/i);
 assert.match(message, /Log: \S*install\.log/);
 assert.ok(message.length < 8000, `failure printed ${message.length} bytes`);
});

test('rer import is just as short when the seed\'s own adapter lets wrangler print its tables', { timeout: 15 * 60_000 }, async t => {
 const seed=await history(t,{seedOwned:true});
 const shown=await boundedImport(t,seed),log=await readFile(join(seed.root,'.seed/installer/install.log'),'utf8');
 assert.match(log,/Executing on local database/);
 assert.match(log,/"results"\s*:/);
 assert.match(shown,/Full output: \S*install\.log/);
 // A failed post-restore database operation still names its real SQL error.
 await seed.run(['reset','--yes']);
 const adapter=join(seed.root,'scripts/installer/local.mjs');
 await writeFile(adapter,(await readFile(adapter,'utf8')).replace('PRAGMA optimize','SELECT * FROM missing_search_index'));
 const failed=await seed.text(['import','--input','exports/history.rer','--yes'],1);
 assert.match(failed.stdout+failed.stderr,/missing_search_index/);
 assert.match(failed.stdout+failed.stderr,/Log: \S*install\.log/);
});
