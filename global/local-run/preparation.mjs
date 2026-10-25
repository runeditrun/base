import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { git, text } from './process.mjs';
import { failure } from './error.mjs';
import { cleanupMerge } from './merge.mjs';
import { needsRecovery } from './journal.mjs';

export async function preflight(checkout) {
 try {
  if (await text(checkout, ['rev-parse', '--show-toplevel']) !== checkout) throw Error();
 } catch { throw failure('checkout_missing', 'Git cannot read this checkout. Repair its HEAD before rerunning rer upgrade.'); }
 const branch = await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allow: [1, 128] });
 const head = await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'], { allow: [1, 128] });
 if (!branch.stdout.trim() || head.code) throw failure('not_on_branch', 'Check out an existing branch before rerunning rer upgrade.');
 if (await text(checkout, ['status', '--porcelain', '--untracked-files=all'])) throw failure('worktree_dirty', 'Commit or stash your changes, including untracked files, before rerunning rer upgrade.');
 return { head: head.stdout.trim(), branch: branch.stdout.trim() };
}

export async function discard(checkout, journal) {
 if (needsRecovery(journal)) throw failure('refused', 'An interrupted upgrade still protects a snapshot; restore or verify it before another upgrade.');
 if (journal.prepared) {
  const ref = await git(checkout, ['show-ref', '--verify', '--quiet', `refs/heads/${journal.prepared.branch}`], { allow: [1] });
  if (!ref.code) await cleanupMerge(checkout, journal.prepared);
 }
 await rm(join(checkout, '.rer/upgrade/journal.json'), { force: true });
}
