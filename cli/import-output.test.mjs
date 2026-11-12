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
 await seed.run(['export', '--output', 'exports/history.rer']);
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
 await boundedImport(t, await history(t, { seedOwned: true }));
});
