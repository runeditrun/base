import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startRuntime, signInThroughOutbox, ReviewError } from './index.mjs';
import { redact } from './privacy.mjs';
import { abortable } from './cancellation.mjs';
import { prepareEvidence } from './history.mjs';
import { runJourney } from './journey.mjs';
import { validateCapturePolicy } from './capture.mjs';

export async function runCli(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  let cancelled;
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(name => [name, () => {
    cancelled ??= name;
    controller.abort(new Error(`Review cancelled by ${cancelled}`));
  }]));
  for (const [name, handler] of Object.entries(handlers)) process.on(name, handler);
  try {
    const code = await review(argv, controller.signal);
    return cancelled ? (cancelled === 'SIGINT' ? 130 : 143) : code;
  } finally {
    for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler);
  }
}

async function review(argv, signal) {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string' }, evidence: { type: 'string' }, 'capture-policy': { type: 'string' }, 'history-limit': { type: 'string' } } });
  if (!values.config || !values.evidence) throw new Error('Usage: node cli.mjs --config review.config.mjs --evidence directory');
  const configPath = resolve(values.config);
  const loaded = await abortable(() => import(pathToFileURL(configPath).href), signal);
  const config = loaded.default ?? loaded;
  if (!config?.start || !Array.isArray(config.routes) || config.routes.length === 0) throw new Error('Config must export start and a nonempty routes array');
  const cwd = resolve(dirname(configPath), config.start.cwd ?? '.');
  const capturePolicy = validateCapturePolicy(values['capture-policy'] ?? config.capturePolicy);
  const historyLimit = values['history-limit'] === undefined ? config.historyLimit : Number(values['history-limit']);
  const secrets = [...new Set([...(config.start.secrets ?? []), ...(config.secrets ?? [])])];
  const proof = await prepareEvidence(resolve(values.evidence), historyLimit);
  const evidence = proof.evidence;
  let runtime, result, failure;
  try {
    runtime = await startRuntime({ ...config.start, cwd, logDir: config.start.logDir ?? resolve(evidence, 'logs'), secrets, fixtures: config.fixtures ?? config.start.fixtures, signal });
    try {
      result = await runJourney({ cwd, origin: runtime.origin, evidence, capturePolicy, historyLimit: proof.historyLimit, widths: config.widths, secrets, signal,
        async run({ page, capture }) {
          let signedIn = false;
          for (const route of config.routes) {
            signal.throwIfAborted();
            if (route.signedIn && !signedIn) {
              if (!config.signIn) throw new Error('A signed-in route requires signIn config');
              await signInThroughOutbox(page, { ...config.signIn, origin: runtime.origin, signal });
              await config.signIn.confirm?.(page, signal);
              signedIn = true;
            }
            const url = new URL(route.path, runtime.origin);
            if (url.origin !== runtime.origin) throw new Error('Route paths must be same-origin');
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            await capture(route.name, { expectStatus: route.expectStatus ?? 200, continueOnFailure: true, canonical: route.canonical ?? false, imageViews: route.imageViews });
          }
        },
      });
    } catch (error) {
      if (!(error instanceof ReviewError)) throw error;
      result = { report: error.report, reportPath: error.reportPath };
    }
  } catch (error) { failure = redact(error.message, secrets); }
  finally {
    try { await runtime?.stop(); }
    catch { failure = 'Runtime cleanup failed'; }
    await proof.finish();
  }
  if (failure) { console.log(`Review failed: ${failure}`); return 1; }
  console.log(`Review ${result.report.passed ? 'passed' : 'failed'}: ${result.report.totals.passed}/${result.report.totals.captures} captures; report: ${result.reportPath}`);
  return result.report.passed ? 0 : 1;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try { process.exitCode = await runCli(); }
  catch { console.log('Review failed: invalid configuration or arguments'); process.exitCode = 1; }
}
