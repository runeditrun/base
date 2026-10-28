// The CLI sorts explicit paths alphabetically. The programmatic runner keeps
// the measured longest-first order while retaining one process per test file.
import assert from 'node:assert/strict';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';

const concurrency = Number(process.argv[2]);
assert.ok([1, 2].includes(concurrency), 'Choose one or two test file workers');
const files = process.argv.slice(3);
assert.ok(files.length, 'Choose test files');
const controller = new AbortController();
const onTerm = () => { process.exitCode = 143; controller.abort(); };
const onInt = () => { process.exitCode = 130; controller.abort(); };
process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
const tests = run({ files, concurrency, signal: controller.signal });
tests.on('test:fail', () => { process.exitCode ||= 1; });
tests.on('end', () => {
  process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
});
tests.compose(tap).pipe(process.stdout);
