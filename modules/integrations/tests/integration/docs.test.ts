import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { SqliteDatabase } from '../../core/sqlite.ts';

const exec = promisify(execFile);
test('README fresh SQLite setup runs verbatim and refuses to masquerade as an upgrade', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't060-docs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const examples = [...readme.matchAll(/```ts\n([\s\S]*?)\n```/g)].map(match => match[1]!);
  assert.equal(examples.length, 3);
  const source = examples[0]!.replaceAll('./modules/integrations/', fileURLToPath(new URL('../../', import.meta.url)));
  const script = join(directory, 'migrate.mts'), dbPath = join(directory, 'data.sqlite');
  await writeFile(script, source);
  const env = { ...process.env, INTEGRATIONS_DB: dbPath };
  await exec(process.execPath, [script], { env });
  const sql = new SqliteDatabase(dbPath);
  try {
    const [rows] = await sql.batch([{ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'integration_%'" }]);
    assert.deepEqual(rows!.map(row => row.name).sort(), [
      'integration_attempts', 'integration_deliveries', 'integration_replays', 'integration_resolutions',
      'integration_token_events', 'integration_token_usage', 'integration_tokens',
    ]);
  } finally { sql.close(); }
  await assert.rejects(exec(process.execPath, [script], { env }), /edition migration ledger/);
});
