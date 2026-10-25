import { isDeepStrictEqual } from 'node:util';
import { backup, readJournal } from './state.mjs';
import { needsRecovery } from './journal.mjs';
import { git } from './process.mjs';
import { recoveryInfo } from './recovery.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export async function printRecovery(checkout) {
 let journal;
 try { journal = await readJournal(checkout); } catch { /* Closed unavailable result below. */ }
 const recovery = await recoveryInfo({ checkout, journalKey: journal?.journalKey, repository: journal?.from?.repository,
  fromCommit: journal?.from?.commit, toCommit: journal?.target?.commit });
 if (recovery.status === 'unavailable') {
  process.stderr.write(`Recovery unavailable (${recovery.reason}). Keep the local upgrade journal and backups for recovery with your agent.\n`);
  if (recovery.reason === 'journal_invalid' && needsRecovery(journal ?? {})) {
   try {
    const head = await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'], { allow: [1, 128] });
    const { metadata } = await backup(checkout, journal.backup);
    if (head.code && metadata.head === journal.head && isDeepStrictEqual(metadata.from, journal.from) && isDeepStrictEqual(metadata.target, journal.target)) {
     process.stderr.write(`Retained journal: .rer/upgrade/journal.json; snapshot: .rer/upgrade/backups/${metadata.name}. Repair unreadable Git HEAD and check out the original branch first. Then run:\nrer upgrade --restore ${quote(metadata.name)} --cwd ${quote(checkout)}\n`);
    }
   } catch { /* Unverifiable snapshots never produce a command. */ }
  }
  return;
 }
 process.stderr.write(`Unfinished upgrade journal: .rer/upgrade/journal.json. Keep it and snapshot .rer/upgrade/backups/${recovery.backup_name} until recovery completes. Previous HEAD: ${recovery.previous_head}.\n`);
 let dirty = false;
 try {
  dirty = Boolean((await git(checkout, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim());
  if (dirty) process.stderr.write('Commit or stash your changes, including untracked files, before restoring. To stash them, run in this checkout:\ngit stash push --include-untracked\n');
  const branch = await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allow: [1, 128] });
  const valid = typeof journal.branch === 'string' && !(await git(checkout, ['check-ref-format', '--branch', journal.branch], { allow: [1, 128] })).code;
  if (valid && branch.stdout.trim() !== journal.branch) process.stderr.write(`Return to the interrupted upgrade's branch first, in this checkout:\ngit checkout ${quote(journal.branch)}\n`);
 } catch { process.stderr.write('Repair Git HEAD and check out the original branch; commit or stash all changes before restoring.\n'); }
 process.stderr.write(`Then restore the saved source and data:\nrer upgrade --restore ${quote(recovery.backup_name)} --cwd ${quote(checkout)}\n`);
 if (dirty) process.stderr.write('After a successful restore, reapply the changes you stashed:\ngit stash pop\n');
}
