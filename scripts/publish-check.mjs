#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runningVersion } from '../cli/version.mjs';
import { parseTimeoutSeconds, timeoutBounds } from './publish-check/timeout.mjs';

const args = process.argv.slice(2);
let seconds = timeoutBounds.default;
for (let i = 0; i < args.length; i++) {
  const raw = args[i] === '--timeout-seconds' ? args[i + 1] : args[i].startsWith('--timeout-seconds=') ? args[i].slice(18) : null;
  if (raw !== null) {
    try { seconds = parseTimeoutSeconds(raw); } catch { /* Python reports invalid arguments. */ }
  }
}
const scratch = mkdtempSync(join(tmpdir(), 'publish-check-'));
const output = join(scratch, 'report.json');
const fd = openSync(output, 'wx', 0o600);
let child, reason, timer;
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
let report, code = 2;
try {
  child = spawn('python3', ['-B', new URL('./publish-check/slots.py', import.meta.url).pathname, ...args], {
    detached: true, stdio: ['pipe', fd, 'inherit', 'pipe'], env: { ...process.env, TMPDIR: scratch },
  });
  closeSync(fd);
  let messages = '';
  child.stdio[3].setEncoding('utf8');
  child.stdio[3].on('data', data => {
    messages += data;
    for (let at; (at = messages.indexOf('\n')) !== -1;) {
      const message = messages.slice(0, at);
      messages = messages.slice(at + 1);
      if (message === 'acquired' && !timer) timer = setTimeout(() => stop('scan.deadline-exceeded'), seconds * 1000);
      else if (message.startsWith('scan.')) reason ??= message;
    }
  });
  const result = await new Promise(resolve => {
    child.once('error', () => resolve(null));
    child.once('close', value => resolve(value));
  });
  if (!reason && [0, 1, 2].includes(result)) {
    report = JSON.parse(readFileSync(output, 'utf8'));
    code = result;
  } else reason ??= 'scan.worker-incomplete';
} catch { reason ??= 'scan.worker-incomplete'; }
finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  rmSync(scratch, { recursive: true, force: true });
}
if (reason) report = {
  schema: 'rer.publish-check/v3', status: 'INCOMPLETE', complete: false, source: null,
  findings: [{ rule: reason, path: '.', commit: null, scope: 'newly-public' }],
  preExisting: [], warnings: [], fixtures: [], reviewed: [], info: [], thirdPartyNotices: [],
  history: { commits: 0, trees: 0, blobs: 0 },
  guarantees: { historyScanned: false, visualRecognition: false, environmentChecked: false },
};
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
