import { locate } from '../checkout.mjs';
import { upgrade } from './upgrade.mjs';
import { readJournal } from './state.mjs';
import { printRecovery } from './recovery-guidance.mjs';

export const help = `Usage: rer upgrade [--check] [--to COMMIT] [--continue] [--restore BACKUP]
                   [--json] [--anchors FILE] [--allow-data-change TABLE] [--cwd DIR]
Update this local app to a verified signed release, keeping owner changes and data.
rer update updates rer itself; rer upgrade updates the app in this checkout.
  --check                    Verify and prepare without applying the update.
  --to COMMIT                Select a signed release by tag or full commit (default: latest).
  --continue                 Apply the resolved, committed rer/update-<tag> integration.
  --restore BACKUP           Restore HEAD, local data and prior running state from a backup.
  --anchors FILE             Use community/test publisher anchors instead of bundled anchors.
  --allow-data-change TABLE  Permit this table's row count to fall; requires a terminal.
  --json                     Print closed phase and result events as JSON lines.
`;
export async function upgradeCommand(args) {
 if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(help); return 0; }
 const options = {}, allowed = [], seen = new Set();
 for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (!['--check', '--to', '--continue', '--restore', '--json', '--anchors', '--allow-data-change', '--cwd'].includes(flag) || seen.has(flag) && flag !== '--allow-data-change') {
   process.stderr.write(help); return 2;
  }
  seen.add(flag);
  if (['--check', '--continue', '--json'].includes(flag)) { options[flag.slice(2)] = true; continue; }
  const value = args[++i];
  if (!value || value.startsWith('-')) { process.stderr.write(help); return 2; }
  if (flag === '--allow-data-change') allowed.push(value); else options[flag.slice(2)] = value;
 }
 if ([options.check, options.continue, Boolean(options.restore)].filter(Boolean).length > 1 || options.restore && options.to) { process.stderr.write(help); return 2; }
 const checkout = locate(['upgrade', ...(options.cwd ? ['--cwd', options.cwd] : [])]).root;
 let recoveryNeeded = false;
 const result = await upgrade({ checkout, onRecovery: () => { recoveryNeeded = true; }, ...options, allowDataChange: allowed, onDiagnostic: message => process.stderr.write(message + '\n'), onPhase: event => {
  if (options.json) process.stdout.write(JSON.stringify({ event: 'phase', ...event }) + '\n');
  else process.stderr.write(`rer upgrade: ${event.phase}${event.error_code ? ` (${event.error_code})` : ''}\n`);
 } });
 if (options.json) process.stdout.write(JSON.stringify({ event: 'result', ...result }) + '\n');
 else process.stdout.write(`rer upgrade: ${result.outcome}${result.release_tag ? ` ${result.release_tag}` : ''}${result.error_code ? ` (${result.error_code})` : ''}\n`);
 if (result.error_code === 'needs_integration') {
  const journal = await readJournal(checkout);
  if (journal?.prepared?.worktree) process.stderr.write(`Resolve and commit the integration in ${journal.prepared.worktree}, then run rer upgrade --continue in the original checkout.\n`);
 }
 if (recoveryNeeded || result.error_code === 'rollback_failed') await printRecovery(checkout);
 return result.outcome === 'updated' || options.check && !result.error_code || options.restore && !result.error_code ? 0 : 1;
}
