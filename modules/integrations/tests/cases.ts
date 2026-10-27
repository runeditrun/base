import type { TestContext } from 'node:test';
export type Case = readonly [string, (context: TestContext) => unknown];
export { caseRow, caseRows as runCases } from '../../mail/tests/helpers/case-row.mjs';
