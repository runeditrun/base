import { loadDependencies } from './versions.mjs';
import { installCollection } from './collect.mjs';
import { capture, CaptureError, validateCapturePolicy } from './capture.mjs';
import { writeReport } from './report.mjs';
import { redact } from './privacy.mjs';
import { abortable } from './cancellation.mjs';
import { prepareEvidence } from './history.mjs';

export const VIEWPORTS = Object.freeze([Object.freeze({ width: 1440, height: 900 }), Object.freeze({ width: 390, height: 844 })]);

export class ReviewError extends Error {
  constructor(report, reportPath) { super(`Review failed; report: ${reportPath}`); this.report = report; this.reportPath = reportPath; }
}

export async function journey(options) {
  const capturePolicy = validateCapturePolicy(options.capturePolicy);
  const proof = await prepareEvidence(options.evidence, options.historyLimit);
  try { return await runJourney({ ...options, evidence: proof.evidence, capturePolicy, historyLimit: proof.historyLimit }); }
  finally { await proof.finish(); }
}

// CLI prepares the directory before starting its runtime/log writer.
export async function runJourney({ cwd, origin, evidence, widths = VIEWPORTS, run, secrets = [], signal, capturePolicy = 'canonical', historyLimit = 2, ...defaults }) {
  validateCapturePolicy(capturePolicy);
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new TypeError('Review origin must be an HTTP IPv4 loopback origin');
  const dependencies = loadDependencies(cwd);
  const report = { schemaVersion: 2, capturePolicy, historyLimit, versions: { pinned: dependencies.pinned, actual: dependencies.actual, chromium: null }, origin, startedAt: new Date().toISOString(), finishedAt: null, captures: [], errors: [], totals: null, passed: false };
  let browser, reportPath;
  const captureFiles = new Set();
  try {
    signal?.throwIfAborted();
    // The caller owns cancellation. Playwright's default SIGINT handler can
    // exit the CLI before the runtime's whole-group cleanup has finished.
    browser = await dependencies.chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false });
    report.versions.chromium = browser.version();
    for (const value of widths) {
      signal?.throwIfAborted();
      const viewport = typeof value === 'number' ? { width: value, height: value === 390 ? 844 : 900 } : value;
      if (!Number.isSafeInteger(viewport.width) || viewport.width <= 0 || !Number.isSafeInteger(viewport.height) || viewport.height <= 0) throw new TypeError('Viewport width and height must be positive integers');
      const context = await browser.newContext({ viewport, baseURL: origin, serviceWorkers: 'block' });
      try {
        await installCollection(context, { origin, secrets, captureFiles });
        const page = await context.newPage();
        await abortable(() => run({ page, context, width: viewport.width, viewport, origin, signal,
          capture: (name, options = {}) => capture(page, name, { ...defaults, ...options, cwd, evidence, capturePolicy,
            secrets: [...new Set([...secrets, ...(options.secrets ?? [])])], onCapture: entry => { report.captures.push(entry); } }),
        }), signal);
      } catch (error) {
        if (!(error instanceof CaptureError)) report.errors.push(redact(error.message, secrets));
      } finally { await context.close(); }
      if (signal?.aborted) break;
    }
  } catch (error) { report.errors.push(redact(error.message, secrets)); }
  finally {
    try { await browser?.close(); }
    catch { report.errors.push('Browser cleanup failed'); }
    reportPath = await writeReport(evidence, report, secrets);
  }
  if (!report.passed) throw new ReviewError(report, reportPath);
  return { report, reportPath };
}
