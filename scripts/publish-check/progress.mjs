// A worker observation is never a report or evidence of scan completion.
import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';

export const progressBytes = 1024;
const phases = new Set(['preparation', 'fetch', 'hydration', 'history-text', 'gitleaks', 'references']);
const operations = new Set(['none', 'git.rev-parse', 'git.fetch', 'git.rev-list', 'git.log', 'git.config',
  'git.ls-tree', 'git.for-each-ref', 'git.cat-file', 'git.other',
  'gitleaks.version', 'gitleaks.git', 'gitleaks.dir', 'gitleaks.stdin', 'gh.graphql', 'gh.rest']);
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const number = value => Number.isSafeInteger(value) && value >= 0;
const count = value => value === null || number(value);

export function readProgress(fd) {
  try {
    if (fd === undefined || fstatSync(fd).size !== progressBytes) return null;
    const frame = Buffer.alloc(progressBytes);
    if (readSync(fd, frame, 0, frame.length, 0) !== frame.length || frame[64] !== 10) return null;
    const body = frame.subarray(65);
    if (createHash('sha256').update(body).digest('hex') !== frame.subarray(0, 64).toString('ascii')) return null;
    const value = JSON.parse(body.toString('utf8'));
    if (!keys(value, ['lastEnteredPhase', 'lastCompletedPhase', 'observedElapsedMs', 'activeOperation',
      'selectedRevisions', 'publicRevisions', 'historyCommits', 'publicCommits', 'hydration']) ||
      ![value.lastEnteredPhase, value.lastCompletedPhase].every(phase => phase === null || phases.has(phase)) ||
      !operations.has(value.activeOperation) || !number(value.observedElapsedMs) ||
      ![value.selectedRevisions, value.publicRevisions, value.historyCommits, value.publicCommits].every(count) ||
      !keys(value.hydration, ['missingBefore', 'missingAfter', 'fetches']) ||
      !Object.values(value.hydration).every(count)) return null;
    // Construct the public shape explicitly. Never merge worker objects.
    return {
      lastEnteredPhase: value.lastEnteredPhase, lastCompletedPhase: value.lastCompletedPhase,
      observedElapsedMs: value.observedElapsedMs, activeOperation: value.activeOperation,
      selectedRevisions: value.selectedRevisions, publicRevisions: value.publicRevisions,
      historyCommits: value.historyCommits, publicCommits: value.publicCommits,
      hydration: { missingBefore: value.hydration.missingBefore, missingAfter: value.hydration.missingAfter,
        fetches: value.hydration.fetches },
    };
  } catch { return null; }
}
