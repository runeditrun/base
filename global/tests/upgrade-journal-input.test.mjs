import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './harness.mjs';

const rer = new URL('../rer.mjs', import.meta.url).pathname;
test('unreadable upgrade journals return a closed refusal without changing the checkout', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-journal-input-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await copyFile(new URL('../../default-seed/OPERATIONS.json', import.meta.url), join(root, 'OPERATIONS.json'));
 await mkdir(join(root, '.rer/upgrade'), { recursive: true });
 const journal = join(root, '.rer/upgrade/journal.json');
 const variants = ['42', '"text"', 'null', '[]', ' '.repeat(1024 * 1024) + '{}',
  '{"nested":' + '['.repeat(100) + '0' + ']'.repeat(100) + '}', '\uFEFF{}',
  '{"version":1,"version":1}', '{"nested":{"key":1,"k\\u0065y":2}}'];
 for (const bytes of variants) {
  await writeFile(journal, bytes);
  const r = await run(process.execPath, [rer, 'upgrade', '--cwd', root, '--json']);
  const output = r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  assert.equal(r.code, 1);
  assert.equal(output.find(e => e.event === 'result')?.outcome, 'refused');
  assert.ok(r.stderr.length > 0);
  assert.doesNotMatch(r.stderr, /TypeError|SyntaxError|\n\s+at /);
  assert.equal(await readFile(journal, 'utf8'), bytes);
 }
});
