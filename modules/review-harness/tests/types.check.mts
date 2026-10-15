import type { Page } from '@playwright/test';
import { PINS, startRuntime, journey, capture, signIn, evaluateGates, type CaptureEntry, type RuntimeOptions, type Report, audit } from '../index.mjs';

declare const page: Page;
const expected: '1.63.0' = PINS['@playwright/test'];
const options: RuntimeOptions = { cwd: '.', command: 'node', args: ['server.mjs', '{PORT}'], fixtures: async origin => { void origin; } };
const runtime = await startRuntime(options);
await signIn(page, { origin: runtime.origin, open: async (_page, signal) => { signal?.throwIfAborted(); return '/auth/oneclick'; } });
const entry: CaptureEntry = await capture(page, 'app', { cwd: '.', evidence: '.', failOn: 'any', keyboard: false, keyboardReason: 'Document only' });
const gate: boolean = evaluateGates(entry).passed;
const { report }: { report: Report } = await journey({ cwd: '.', origin: runtime.origin, evidence: '.', capturePolicy: 'failures', historyLimit: 0, widths: [390, { width: 1440, height: 900 }], async run({ page, context, capture, viewport }) {
  await page.goto('/app');
  await capture('app', { expectStatus: 200, canonical: true, imageViews: ['viewport', 'full-page'] });
  void [context, viewport];
} });
// @ts-expect-error Unknown gate mode must not be silently accepted.
evaluateGates(entry, { failOn: 'everything' });
// @ts-expect-error Runtime command is required.
startRuntime({ cwd: '.' });
void [expected, gate, report];

const audited = await audit(page, 'state', { cwd: '.' });
void [audited.gate.passed, entry.images, entry.imageRetention];
// @ts-expect-error Unknown capture policies must be rejected.
journey({ cwd: '.', origin: '.', evidence: '.', capturePolicy: 'none', run: async () => {} });
