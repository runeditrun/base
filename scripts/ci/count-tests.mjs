// Counts Base's tests and fails over the cap in test-budget.json (owner, 15 Oct 2026: "Default to 200").
// One count per registration (test( / it( / def test_), and one per test entry script with no registration.
// Raising the cap needs a written reason in test-budget.json.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { testSource } from '../../composition/git-source.mjs';

const { cap, excluded = [] } = JSON.parse(readFileSync('test-budget.json', 'utf8'));
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
const code = /\.(?:mjs|cjs|js|ts|tsx|mts|py)$/;
const candidates = files.filter(file => code.test(file) && testSource(file) && !excluded.some(prefix => file.startsWith(prefix)));
const source = Object.fromEntries(candidates.map(file => [file, readFileSync(file, 'utf8')]));
const imported = new Set();
for (const text of Object.values(source)) {
  for (const match of text.matchAll(/['"`](\.{1,2}\/[^'"`\n]+)['"`]/g)) imported.add(basename(match[1]).replace(/\.[^.]+$/, ''));
}
const registrations = text => (text.match(/^\s*(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/gm) ?? []).length
  + (text.match(/^\s*(?:async\s+)?def test_/gm) ?? []).length;
const counts = new Map();
for (const [file, text] of Object.entries(source)) {
  let count = registrations(text);
  const entry = /\.test\.[^/]+$|(?:^|\/)(?:tests|test_[^/]+|[^/]*_tests)\.py$/.test(file)
    || (!imported.has(basename(file).replace(/\.[^.]+$/, '')) && /\bassert\b/.test(text));
  if (!count && entry) count = 1;
  if (count) counts.set(file, count);
}
const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
console.log(`TEST_COUNT ${total} cap ${cap} in ${counts.size} files`);
if (total > cap) {
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, count]) => `  ${count} ${file}`).join('\n');
  console.error(`Base has ${total} tests, over the cap of ${cap}. Delete tests or replace one with another; the largest files:\n${top}`);
  process.exit(1);
}
