import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { failure } from './error.mjs';

const limit = 1024 * 1024;
const invalid = name => failure('refused', `Unreadable ${name}; keep this file and any upgrade backups in .rer/upgrade. Ask your agent to recover the journal before rerunning rer upgrade.`);

// Bound control records before parsing and reject ambiguous members at every
// object depth, including escaped duplicate keys. Never echo their contents.
export async function readControl(path, name) {
 let file;
 try {
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid() || stat.size > limit) throw invalid(name);
  const bytes = Buffer.alloc(stat.size + 1);
  let length = 0;
  while (length < bytes.length) {
   const read = await file.read(bytes, length, bytes.length - length, null);
   if (!read.bytesRead) break;
   length += read.bytesRead;
  }
  if (length !== stat.size) throw invalid(name);
  const source = bytes.subarray(0, length).toString('utf8');
  const stack = [];
  for (const token of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
   const value = token[0];
   if (value === '{' || value === '[') {
    stack.push(value === '{' ? new Set() : null);
    if (stack.length > 64) throw invalid(name);
   } else if (value === '}' || value === ']') stack.pop();
   else if (/^\s*:/.test(source.slice(token.index + value.length))) {
    const keys = stack.at(-1), key = JSON.parse(value);
    if (!keys || keys.has(key)) throw invalid(name);
    keys.add(key);
   }
  }
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(name);
  return value;
 } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw invalid(name);
 } finally { await file?.close(); }
}

/** Closed durable-artifact outcome table (also in global/README.md):
 * PRE-SWITCH: intent, preparing, needs_integration, prepared, stopping.
 *   No tracked source/database needs undoing. Discard and prepare at today's HEAD.
 * PROTECTED: switch_pending, switched, installed, started, verified,
 *   rolling_back, rollback_failed. Retain until verified or snapshot restored,
 *   regardless of today's HEAD. switch_pending protects the Git/write gap.
 * TERMINAL: complete, rolled_back. Data is settled; discardable at any HEAD.
 *   runtimeSettled=false still requires settling runtime custody before redo.
 * Runtime intent is inherited only from the exact crashed custodian reclaimed
 * by this attempt; an owner's later start/stop supersedes it.
 */
export const preSwitchStages = ['preparing', 'needs_integration', 'prepared', 'stopping'];
export const recoveryStages = ['switch_pending', 'switched', 'installed', 'started', 'verified', 'rolling_back', 'rollback_failed'];
export const terminalStages = ['complete', 'rolled_back'];
export const journalStages = [...preSwitchStages, ...recoveryStages, ...terminalStages];
export const needsRecovery = journal => recoveryStages.includes(journal.stage);
export const artifactOutcome = journal => needsRecovery(journal) ? 'protected' :
 terminalStages.includes(journal.stage) ? 'terminal' : preSwitchStages.includes(journal.stage) ? 'pre-switch' : 'none';
