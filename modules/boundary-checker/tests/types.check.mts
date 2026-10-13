import { checkBoundaries, type BoundaryConfig, type BoundaryResult, type Rule } from '../index.mjs';
const config: BoundaryConfig = { version: 1, includeTypeOnly: false, rules: {
  R1: { allowedPrefixes: ['src/core/api'] }, R2: { mounts: { 'src/core/app/mount.ts': ['src/ext/index.ts'] } },
  R3: false, R4: { clientModules: ['src/core/platform/db/client'] }, R5: { importScopes: ['**'] },
  R6: { enabled: false }, R7: { files: ['src/ext/index.client.*'] }, R8: { enabled: true, prefix: '/**' },
} };
const result: BoundaryResult = await checkBoundaries({ root: '.', config });
const rule: Rule | undefined = result.violations[0]?.rule;
const target: string | null | undefined = result.violations[0]?.target;
// @ts-expect-error unknown rule
const invalid: BoundaryConfig = { version: 1, rules: { R9: false } };
// @ts-expect-error pins are arrays, not strings
const invalidMount: BoundaryConfig = { version: 1, rules: { R2: { mounts: { 'src/mount.ts': 'src/ext/index.ts' } } } };
void [result.files, rule, target, invalid, invalidMount];
