import { test } from 'node:test';
import { registerAgreementSigningConformance } from '../conformance/index.mjs';
import { openSigningRuntime } from './runtime.mjs';

registerAgreementSigningConformance({
  test,
  adapter: { profiles: ['text-terms', 'pdf-html-signature'], open: openSigningRuntime },
});
