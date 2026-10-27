import test from 'node:test';
import assert from 'node:assert/strict';
import { namedSteps } from './fold-steps.mjs';

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
});
