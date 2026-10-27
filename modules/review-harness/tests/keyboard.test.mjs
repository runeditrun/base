import { namedSteps } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { keyboardCheck } from '../settle.mjs';

function page(active, visible) {
  const document = { activeElement: null, body: { getAttribute: () => null, setAttribute() {}, removeAttribute() {}, focus() {}, matches: () => visible }, documentElement: {} };
  const target = active === 'body' ? document.body : active === 'root' ? document.documentElement : { matches: selector => selector === ':focus-visible' && visible };
  return { evaluate: async fn => runInNewContext(`(${fn.toString()})()`, { document }), keyboard: { press: async key => { assert.equal(key, 'Tab'); document.activeElement = target; } } };
}
test("keyboard admission requires visible focus or an explained opt-out", async t => {
  const step = namedSteps(t);
  await step('keyboard must leave the body and root, even when a focus-visible body is possible', async () => {
    assert.equal((await keyboardCheck(page('body', true))).passed, false);
    assert.equal((await keyboardCheck(page('root', true))).passed, false);
  });
  
  await step('keyboard requires focus-visible on the focused element', async () => {
    assert.equal((await keyboardCheck(page('element', false))).passed, false);
    assert.equal((await keyboardCheck(page('element', true))).passed, true);
  });
  
  await step('a keyboard opt-out records its reason and rejects an empty reason', async () => {
    assert.deepEqual(await keyboardCheck(page('body', false), { keyboard: false, keyboardReason: 'Static text' }), { enabled: false, passed: true, reason: 'Static text' });
    await assert.rejects(keyboardCheck(page('body', false), { keyboard: false }), /requires keyboardReason/);
  });
})



