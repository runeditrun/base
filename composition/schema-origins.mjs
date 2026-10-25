import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { safePath } from './git-source.mjs';

// A numbered seed migration retains the module origin verbatim. Compile the
// origin in a disposable database to check the complete declared table inventory;
// checking filenames alone cannot catch an omitted authority/history table.
export async function verifySchemaOrigin(base, { source, target, tables }) {
  safePath(source); safePath(target);
  const [origin, copy] = await Promise.all([readFile(resolve(base, source)), readFile(resolve(base, target))]);
  if (!origin.equals(copy)) throw new Error(`Migration ${target} differs from its schema origin ${source}; preserve applied history and add a new migration for later changes.`);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(origin.toString('utf8'));
    const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    if (JSON.stringify(actual) !== JSON.stringify([...tables].sort())) throw new Error(`Schema inventory differs from ${source}; declare every portable and excluded table before export.`);
  } finally { db.close(); }
  return { source, sha256: createHash('sha256').update(copy).digest('hex') };
}
