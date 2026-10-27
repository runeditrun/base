import test from 'node:test';
import assert from 'node:assert/strict';
import { namedSteps, caseRows } from './fold-steps.mjs';

test('named rows retain cleanup scope, failure diagnostics and their original timeout', async t => {
  const step = namedSteps(t), events = [];
  let completedSignal;
  await step('first row', async context => {
    assert.equal(context.name, 'first row');
    completedSignal = context.signal;
    context.after(() => events.push('first cleanup'));
    events.push('first assertion');
  });
  assert.deepEqual(events, ['first assertion', 'first cleanup']);
  assert.equal(completedSignal.aborted, true);
  const assertion = new Error('original assertion');
  await assert.rejects(step('failed row', async context => {
    context.after(() => { events.push('failed cleanup'); throw new Error('cleanup failure'); });
    context.after(() => events.push('last cleanup'));
    throw assertion;
  }), error => error instanceof AggregateError && error.message.includes('failed row') && error.errors[0] === assertion && error.errors[1].message === 'cleanup failure');
  assert.deepEqual(events.slice(-2), ['failed cleanup', 'last cleanup']);
  let signal;
  await assert.rejects(step('bounded row', { timeout: 5 }, async context => {
    signal = context.signal;
    context.after(() => events.push('timed cleanup'));
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
  }), /bounded row: Step exceeded its original timeout/);
  assert.equal(signal.aborted, true);
  assert.equal(events.at(-1), 'timed cleanup');
  const rows = [];
  await assert.rejects(caseRows(t, [
    ['outer', async context => {
      const leaf = namedSteps(context);
      await leaf('broken fixture', async row => {
        row.after(() => rows.push('broken cleanup'));
        assert.equal({ value: 'corrupted' }.value, 'original');
      });
      await leaf('sibling', row => {
        row.after(() => rows.push('sibling cleanup'));
        rows.push('sibling assertion');
        assert.equal(2 + 2, 4);
      });
      await caseRows(context, [
        ['nested failure', () => { throw new Error('nested fault'); }],
        ['nested sibling', () => { rows.push('nested assertion'); assert.ok(true); }],
      ]);
    }],
    ['last sibling', () => { rows.push('last assertion'); assert.ok(true); }],
  ]), error => error instanceof AggregateError &&
    error.errors.length === 2 && /broken fixture/.test(error.message) &&
    /nested failure/.test(error.message));
  assert.deepEqual(rows, ['broken cleanup', 'sibling assertion', 'sibling cleanup', 'nested assertion', 'last assertion']);

});
