export function evaluateGates(entry, { failOn = 'serious', expectStatus = 200 } = {}) {
  if (!['serious', 'any'].includes(failOn)) throw new TypeError('failOn must be serious or any');
  const failures = [];
  const fail = (name, condition) => { if (condition) failures.push(name); };
  fail('axe', entry.axe.violations.some(violation => failOn === 'any' || ['serious', 'critical'].includes(violation.impact)));
  fail('overflow', Math.max(entry.overflow.document, entry.overflow.body) - entry.overflow.viewport > 1);
  fail('pageErrors', entry.errors.page.length > 0);
  // Keep browser-generated resource diagnostics, but gate their underlying
  // request once. Application console errors always have their own gate.
  fail('consoleErrors', entry.errors.console.some(message => !message.resource || ![
    ...entry.failedResponses.map(response => response.url), ...entry.externalRequests,
  ].includes(message.url)));
  fail('failedResponses', entry.failedResponses.some(response => !response.mainDocument || response.status !== expectStatus));
  fail('externalRequests', entry.externalRequests.length > 0);
  fail('secrets', entry.secretsFound.length > 0);
  fail('keyboard', !entry.keyboard.passed);
  fail('documentStatus', entry.documentStatus !== expectStatus);
  fail('settle', entry.errors.settle.length > 0);
  return { passed: failures.length === 0, failures };
}
