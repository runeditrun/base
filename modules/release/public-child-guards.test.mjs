import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sourceTree } from './export.mjs';

test('source cannot inject Git configuration through filesystem aliases before public initialization', t => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'rer-public-path-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  for (const [index, path] of ['.GIT/config', '.git./config', '.git /config', '.g\u200cit/config'].entries()) {
    const target = resolve(temporary, String(index));
    const source = { entries: new Map([[path, { type: 'blob', mode: '100644' }]]), bytes: () => Buffer.from('[core]\n') };
    assert.throws(() => sourceTree(source, target), /Git control paths/);
    assert.equal(existsSync(resolve(target, path)), false);
  }
});
