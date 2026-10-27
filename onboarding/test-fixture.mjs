// Byte-identical runner: runeditrun/base db43e31e48e6796354479019fade1390aad1ec46
// modules/import-kit/tests/helpers/case-row.ts. Node's native type stripping keeps
// the proven source intact. Arbitrary fulfilled orphan promises are undetectable;
// later rejecting orphans remain the test runner's responsibility (use defer).
export { caseRow, caseRows } from './case-row.ts';
