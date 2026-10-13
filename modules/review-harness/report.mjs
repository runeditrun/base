import { join } from 'node:path';
import { privateDirectory, privateFile } from './files.mjs';
import { sanitize } from './privacy.mjs';

export async function writeReport(evidence, report, secrets = []) {
  report.finishedAt = new Date().toISOString();
  report.totals = { captures: report.captures.length, passed: report.captures.filter(entry => entry.gate.passed).length, failed: report.captures.filter(entry => !entry.gate.passed).length };
  report.passed = report.totals.failed === 0 && report.errors.length === 0;
  await privateDirectory(evidence);
  const path = join(evidence, 'review.json');
  await privateFile(path, JSON.stringify(sanitize(report, secrets), null, 2) + '\n');
  return path;
}
