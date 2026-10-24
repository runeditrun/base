import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { backup, readJournal } from './state.mjs';
import { githubRepository } from './release.mjs';
import { text } from './process.mjs';
import { validBackupName } from './state-manifest.mjs';

const SHA = /^[a-f0-9]{40}$/;
const CHECKOUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const JOURNAL_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const unavailable = reason => ({ status: 'unavailable', reason });

function releaseMatches(release, repository, commit) {
 return object(release) && release.repository === repository && release.commit === commit;
}

/** Project only locally verified repair facts. Private journal fields and read
 * failures never escape this reader, including for older unbound journals. */
export async function recoveryInfo(options = {}) {
 try {
  if (!object(options)) return unavailable('journal_invalid');
  let { checkout } = options;
  const { journalKey, repository, fromCommit, toCommit } = options;
  checkout = await realpath(checkout);
  const checkoutName = basename(checkout);
  const journal = await readJournal(checkout);
  if (journal === null) return unavailable('journal_missing');
  if (!CHECKOUT_NAME.test(checkoutName)) return unavailable('checkout_name_unsafe');
  if (!object(journal) || journal.version !== 1 || journal.stage !== 'rollback_failed'
    || !matches(JOURNAL_KEY, journalKey) || journal.journalKey !== journalKey
    || !matches(REPOSITORY, repository) || !matches(SHA, fromCommit) || !matches(SHA, toCommit)
    || journal.checkout_name !== checkoutName || !matches(SHA, journal.head)
    || !releaseMatches(journal.from, repository, fromCommit)
    || !releaseMatches(journal.target, repository, toCommit)) return unavailable('journal_invalid');
  const origins = (await text(checkout, ['config', '--get-all', 'remote.origin.url'])).split('\n');
  if (origins.length !== 1 || githubRepository(origins[0]) !== repository) return unavailable('journal_invalid');
  if (journal.backup === undefined || journal.backup === null) return unavailable('backup_missing');
  if (!validBackupName(journal.backup)) return unavailable('journal_invalid');
  let metadata;
  try { ({ metadata } = await backup(checkout, journal.backup)); }
  catch { return unavailable('backup_missing'); }
  if (!object(metadata) || metadata.name !== journal.backup || metadata.head !== journal.head
    || !releaseMatches(metadata.from, repository, fromCommit)
    || !releaseMatches(metadata.target, repository, toCommit)
    || !isDeepStrictEqual(metadata.from, journal.from)
    || !isDeepStrictEqual(metadata.target, journal.target)) return unavailable('journal_invalid');
  return { status: 'available', previous_head: journal.head, checkout_name: checkoutName, backup_name: journal.backup };
 } catch { return unavailable('journal_invalid'); }
}
