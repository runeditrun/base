import { namedSteps } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates } from '../index.mjs';

function clean() {
  return { axe: { violations: [] }, overflow: { viewport: 390, document: 390, body: 390 }, errors: { page: [], console: [], settle: [] }, failedResponses: [], externalRequests: [], secretsFound: [], keyboard: { passed: true }, documentStatus: 200 };
}
test("axe severity policy covers every impact and mode", async t => {
  const step = namedSteps(t);
  for (const impact of ['serious', 'critical']) await step(`axe ${impact} gate`, () => {
    const entry = clean(); entry.axe.violations.push({ impact });
    assert.deepEqual(evaluateGates(entry).failures, ['axe']);
  });

  await step('axe any mode catches moderate and minor; default permits them', () => {
    const entry = clean(); entry.axe.violations.push({ impact: 'moderate' }, { impact: 'minor' });
    assert.equal(evaluateGates(entry).passed, true);
    assert.deepEqual(evaluateGates(entry, { failOn: 'any' }).failures, ['axe']);
  });
})


test("overflow checks both document and body boundaries", async t => {
  const step = namedSteps(t);
  for (const field of ['document', 'body']) await step(`overflow ${field} gate`, () => {
    const entry = clean(); entry.overflow[field] += 1;
    assert.deepEqual(evaluateGates(entry), { passed: true, failures: [] });
    entry.overflow[field] += 1;
    assert.deepEqual(evaluateGates(entry).failures, ['overflow']);
  });
})

const cases = {
  pageErrors: entry => entry.errors.page.push('broken script'),
  consoleErrors: entry => entry.errors.console.push({ text: 'broken console', url: '', resource: false }),
  failedResponses: entry => entry.failedResponses.push({ url: 'http://127.0.0.1/missing.js', status: 404, mainDocument: false }),
  externalRequests: entry => entry.externalRequests.push('http://127.0.0.1:1234/foreign'),
  secrets: entry => entry.secretsFound.push(0),
  keyboard: entry => { entry.keyboard.passed = false; },
  documentStatus: entry => { entry.documentStatus = 404; },
  settle: entry => entry.errors.settle.push('busy'),
};
for (const [name, change] of Object.entries(cases)) test(`${name} gate`, () => {
  const entry = clean(); change(entry);
  assert.deepEqual(evaluateGates(entry).failures, [name]);
});
test('an expected 404 document passes while an unexpected 404 subresource still fails', () => {
  const entry = clean(); entry.documentStatus = 404;
  entry.failedResponses.push({ url: 'http://127.0.0.1/not-found', status: 404, mainDocument: true });
  assert.equal(evaluateGates(entry, { expectStatus: 404 }).passed, true);
  entry.failedResponses.push({ url: 'http://127.0.0.1/missing.js', status: 404, mainDocument: false });
  assert.deepEqual(evaluateGates(entry, { expectStatus: 404 }).failures, ['failedResponses']);
});
test('derived browser console diagnostics retain a single underlying request gate', () => {
  const entry = clean();
  entry.externalRequests.push('http://127.0.0.1:1234/foreign');
  entry.errors.console.push({ text: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', url: entry.externalRequests[0], resource: true });
  assert.deepEqual(evaluateGates(entry).failures, ['externalRequests']);
});
