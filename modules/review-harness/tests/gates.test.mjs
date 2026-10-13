import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates, AXE_TAGS, VIEWPORTS } from '../index.mjs';

function clean() {
  return { axe: { violations: [] }, overflow: { viewport: 390, document: 390, body: 390 }, errors: { page: [], console: [], settle: [] }, failedResponses: [], externalRequests: [], secretsFound: [], keyboard: { passed: true }, documentStatus: 200 };
}
test('published defaults include all five WCAG tags and the two specified viewports', () => {
  assert.deepEqual(AXE_TAGS, ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  assert.deepEqual(VIEWPORTS, [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
});
test('clean measurements pass, including one pixel of overflow', () => {
  const entry = clean();
  entry.overflow.body++;
  assert.deepEqual(evaluateGates(entry), { passed: true, failures: [] });
});
for (const impact of ['serious', 'critical']) test(`axe ${impact} gate`, () => {
  const entry = clean(); entry.axe.violations.push({ impact });
  assert.deepEqual(evaluateGates(entry).failures, ['axe']);
});
test('axe any mode catches moderate and minor; default permits them', () => {
  const entry = clean(); entry.axe.violations.push({ impact: 'moderate' }, { impact: 'minor' });
  assert.equal(evaluateGates(entry).passed, true);
  assert.deepEqual(evaluateGates(entry, { failOn: 'any' }).failures, ['axe']);
});
for (const field of ['document', 'body']) test(`overflow ${field} gate`, () => {
  const entry = clean(); entry.overflow[field] += 2;
  assert.deepEqual(evaluateGates(entry).failures, ['overflow']);
});
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
