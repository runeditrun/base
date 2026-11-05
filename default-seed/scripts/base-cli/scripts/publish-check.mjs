#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runningVersion } from '../cli/version.mjs';
import { parseTimeoutSeconds, timeoutBounds } from './publish-check/timeout.mjs';
import { controlReader, diagnosticLimit, osFailure, processFact, readReport, workerFact } from './publish-check/diagnostics.mjs';

const args = process.argv.slice(2);
let seconds = timeoutBounds.default;
for (let i = 0; i < args.length; i++) {
  const raw = args[i] === '--timeout-seconds' ? args[i + 1] : args[i].startsWith('--timeout-seconds=') ? args[i].slice(18) : null;
  if (raw !== null) {
    try { seconds = parseTimeoutSeconds(raw); } catch { /* Python reports invalid arguments. */ }
  }
}
let scratch, fd, child, reason, timer;
const diagnostics = [];
const record = fact => { if (fact && diagnostics.length < diagnosticLimit) diagnostics.push(fact); };
const stop = value => {
  reason ??= value;
  // The child remains unreaped until its close handler; descendants (native
  // Git and Gitleaks) share the private process group and this total deadline.
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
};
const interrupt = () => stop('scan.interrupted');
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
let report, code = 2, stage = 'scratch';
try {
  scratch = mkdtempSync(join(tmpdir(), 'publish-check-'));
  const output = join(scratch, 'report.json');
  fd = openSync(output, 'wx', 0o600);
  stage = 'slot';
  child = spawn('python3', ['-B', new URL('./publish-check/slots.py', import.meta.url).pathname, ...args], {
    // Neither holder tracebacks nor worker stderr are safe public diagnostics.
    detached: true, stdio: ['pipe', fd, 'ignore', 'pipe'], env: { ...process.env, TMPDIR: scratch },
  });
  const finished = new Promise(resolve => {
    let error;
    child.once('error', value => { error = value; });
    child.once('close', (exitCode, signal) => resolve({ error, exitCode, signal }));
  });
  closeSync(fd);
  fd = undefined;
  child.stdio[3]?.setEncoding('utf8');
  child.stdio[3]?.on('data', controlReader(message => {
    if (message === 'acquired' && !timer) timer = setTimeout(() => stop('scan.deadline-exceeded'), seconds * 1000);
    else if (message === 'waiting') process.stderr.write('waiting for a scan slot\n');
    else if (['scan.slot-timeout', 'scan.slot-configuration'].includes(message)) reason ??= message;
    else record(workerFact(message));
  }));
  const result = await finished;
  const parsed = readReport(output);
  // Report errors are secondary facts even when the process failed first.
  if (reason || result.error || result.signal || ![0, 1, 2].includes(result.exitCode) || parsed.diagnostic) {
    reason ??= 'scan.worker-incomplete';
    record(processFact('slot', result));
    record(parsed.diagnostic);
  } else {
    report = parsed.report;
    code = result.exitCode;
  }
} catch (error) {
  reason ??= 'scan.worker-incomplete';
  record(osFailure(stage, 'io.error', error));
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  if (fd !== undefined) {
    try { closeSync(fd); }
    catch (error) { record(osFailure('cleanup', 'cleanup.close-error', error)); }
  }
  if (scratch) {
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch (error) {
      record(osFailure('cleanup', 'cleanup.remove-error', error));
      // Retain existing failures, and never publish PASS after failed cleanup.
      if (code === 0) { reason ??= 'scan.worker-incomplete'; code = 2; }
    }
  }
}
if (reason) report = {
  schema: 'rer.publish-check/v3', status: 'INCOMPLETE', complete: false, source: null,
  findings: [{ rule: reason, path: '.', commit: null, scope: 'newly-public' }],
  preExisting: [], warnings: [], fixtures: [], reviewed: [], info: [], thirdPartyNotices: [],
  history: { commits: 0, trees: 0, blobs: 0 },
  guarantees: { historyScanned: false, visualRecognition: false, environmentChecked: false },
};
if (reason || diagnostics.some(fact => fact.stage === 'cleanup')) report.diagnostics = diagnostics;
if (report.help) process.stdout.write(report.help);
else {
  for (const finding of report.findings) {
    if (finding.rule === 'scan.usage') process.stderr.write(`publish-check: ${finding.message}; see --help\n`);
  }
  report.implementation ??= {};
  report.implementation.version = runningVersion();
  process.stdout.write(JSON.stringify(report) + '\n');
}
process.exitCode = code;
