import { caseRows } from '../deploy-kit/tests/fold-case.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testSummary } from './test-summary.mjs';

const summaryCaseRows = [];
const summaryCase = (name, run) => summaryCaseRows.push({name,run});

const counts = overrides => ({ tests: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, ...overrides });
function parse(text) {
  const summary = testSummary();
  summary.write(Buffer.from(text));
  return summary.finish();
}

summaryCase('Node spec success uses its explicit total, ignoring suites and duration', () => {
  assert.deepEqual(parse('✔ one (2ms)\nℹ tests 4\nℹ suites 1\nℹ pass 4\nℹ fail 0\nℹ duration_ms 12.3\n'),
    counts({ tests: 4, passed: 4 }));
});

summaryCase('Node TAP failure, skipped, cancelled and todo remain separate outcomes', () => {
  assert.deepEqual(parse('TAP version 13\nnot ok 1 - failure\n1..8\n# tests 8\n# pass 2\n# fail 1\n# cancelled 1\n# skipped 3\n# todo 1\n'),
    counts({ tests: 8, passed: 2, failed: 1, skipped: 3, cancelled: 1, todo: 1 }));
});

summaryCase('Playwright success counts the completed summary', () => {
  assert.deepEqual(parse('Running 349 tests using 2 workers\n  ✓ 349 [chromium] › check (30ms)\n  349 passed (3m)\n'),
    counts({ tests: 349, passed: 349 }));
});

summaryCase('Playwright failure and skipped-only runs need no passed line', () => {
  assert.deepEqual(parse('  2 failed\n    [chromium] › test.spec.ts:12:1 › failure\n  3 skipped\n'),
    counts({ tests: 5, failed: 2, skipped: 3 }));
  assert.deepEqual(parse('  4 skipped\n'), counts({ tests: 4, skipped: 4 }));
});

summaryCase('Playwright flaky and unfinished outcomes are counted once without inflating passes', () => {
  assert.deepEqual(parse('  2 failed\n  1 interrupted\n  3 flaky\n  4 skipped\n  5 did not run\n  6 passed (1.2s)\n  1 error was not a part of any test, see above for details\n'),
    counts({ tests: 21, passed: 6, failed: 2, skipped: 4, flaky: 3, interrupted: 1, notRun: 5 }));
});

summaryCase('sequential Node and Playwright suites accumulate without double counting totals', () => {
  assert.deepEqual(parse('# tests 6\n# pass 4\n# fail 1\n# skipped 1\n  349 passed (3m)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n  1 flaky\n  2 passed (400ms)\n'),
    counts({ tests: 360, passed: 357, failed: 1, skipped: 1, flaky: 1 }));
});

summaryCase('all byte boundaries preserve Unicode, ANSI, CRLF and final unterminated lines', () => {
  const bytes = Buffer.from('\x1b[36mℹ tests 2\x1b[39m\r\nℹ pass 2\r\n\x1b[32m  349 passed\x1b[39m\x1b[2m (3m)\x1b[22m');
  const expected = counts({ tests: 351, passed: 351 });
  for (let split = 0; split <= bytes.length; split++) {
    const summary = testSummary();
    summary.write(bytes.subarray(0, split));
    summary.write(bytes.subarray(split));
    assert.deepEqual(summary.finish(), expected, `byte boundary ${split}`);
    assert.deepEqual(summary.finish(), expected, 'finalizing again cannot duplicate a summary');
  }
  const summary = testSummary();
  for (const byte of bytes) summary.write(Buffer.from([byte]));
  assert.deepEqual(summary.finish(), expected);
});

summaryCase('only anchored numeric summaries survive, never diagnostics or arbitrary digits', () => {
  const output = [
    'secret=test-private-value-123', 'log # tests 19', '# tests 19 secret=test-private-value',
    '  3 passed (test-private-value)', '  3 passed (1s) secret=test-private-value',
    '  3 passed', '  3 failed: test-private-value', '3 failed', '    3 failed',
    '  -3 skipped', '  1.5 flaky', '  2 failed (1s)', '# fail NaN',
    '  ✓ 3 passed (1ms)', '# duration_ms 456', 'Running 42 tests using 2 workers',
    '  999999999999999999999999999999 failed', '# tests 999999999999999999999999999999',
  ].join('\n');
  assert.deepEqual(parse(output), counts());
  assert.equal(JSON.stringify(parse(output)).includes('test-private-value'), false);
});

summaryCase('oversized lines are discarded whole, including a summary-shaped suffix across chunks', () => {
  const summary = testSummary();
  summary.write(Buffer.from('x'.repeat(9000)));
  summary.write(Buffer.from('# tests 999\n'));
  summary.write(Buffer.from('x'.repeat(9000) + '  999 passed (1s)\n'));
  summary.write(Buffer.from('  2 passed (1ms)\n'));
  assert.deepEqual(summary.finish(), counts({ tests: 2, passed: 2 }));
});

summaryCase('duration units stay numeric and counters remain safe integers', () => {
  for (const duration of ['0ms', '1.2s', '3m', '2.1h', '1d']) {
    assert.deepEqual(parse(`  1 passed (${duration})\n`), counts({ tests: 1, passed: 1 }));
  }
  assert.deepEqual(parse(`# tests ${Number.MAX_SAFE_INTEGER}\n# tests 1\n  1 passed (1ms)\n`),
    counts({ tests: Number.MAX_SAFE_INTEGER }));
});

test('release test summaries count only bounded reporter outcomes across byte boundaries', async (t) => {
  await caseRows(t, summaryCaseRows.map(({name,run}) => [name,run]));
});
