// Failure facts are an allowlisted protocol, never child stderr or exception text.
import { constants } from 'node:os';
import { readFileSync } from 'node:fs';

const errnos = new Map(Object.entries(constants.errno).map(([name, number]) => [number, name]));
const signals = new Set(Object.keys(constants.signals));
export const diagnosticLimit = 8;
export const controlLineLimit = 128;

export function osFailure(stage, code, error) {
  return { stage, code, errno: errnos.get(Math.abs(error?.errno)) ?? 'UNKNOWN' };
}

export function processFact(stage, { error, exitCode, signal }) {
  if (error) return osFailure(stage, 'process.launch-error', error);
  if (signal) return { stage, code: 'process.signal', signal: signals.has(signal) ? signal : 'UNKNOWN' };
  return { stage, code: 'process.exit', exitCode: Number.isInteger(exitCode) ? exitCode : null };
}

// fd 3 is private to the slot holder; it is not inherited by the scan worker.
// Still bound framing and accept only fixed tokens and typed numeric fields.
export function controlReader(onMessage) {
  let pending = '', overflow = false;
  return data => {
    for (const character of data) {
      if (character === '\n') {
        if (!overflow) onMessage(pending);
        pending = ''; overflow = false;
      } else if (!overflow) {
        if (pending.length < controlLineLimit) pending += character;
        else { pending = ''; overflow = true; }
      }
    }
  };
}

export function workerFact(message) {
  const match = /^(worker\.(exit|signal|launch)|slot\.(directory|open|lock|wait)):(\d{1,3})$/.exec(message);
  if (!match) return;
  const number = Number(match[4]);
  if (match[2] === 'exit' && number <= 255) return { stage: 'worker', code: 'process.exit', exitCode: number };
  if (match[2] === 'signal' && number > 0 && number < 128) {
    const signal = Object.entries(constants.signals).find(([, value]) => value === number)?.[0] ?? 'UNKNOWN';
    return { stage: 'worker', code: 'process.signal', signal };
  }
  if (match[2] === 'launch') return { stage: 'worker', code: 'process.launch-error', errno: errnos.get(number) ?? 'UNKNOWN' };
  if (match[3]) return { stage: 'slot-' + match[3], code: 'os.error', errno: errnos.get(number) ?? 'UNKNOWN' };
}

export function readReport(path) {
  let text, report;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { return { diagnostic: osFailure('report', 'report.read-error', error) }; }
  if (!text.trim()) return { diagnostic: { stage: 'report', code: 'report.empty' } };
  try { report = JSON.parse(text); }
  catch { return { diagnostic: { stage: 'report', code: 'report.parse-error' } }; }
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      !(typeof report.help === 'string' || (Array.isArray(report.findings) &&
        report.findings.every(finding => finding && typeof finding.rule === 'string')))) {
    return { diagnostic: { stage: 'report', code: 'report.shape-error' } };
  }
  return { report };
}
