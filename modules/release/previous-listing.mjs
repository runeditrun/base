import { committedSource, git } from './source.mjs';
import { listingContent } from './listing.mjs';

const order = (a, b) => a === b ? 0 : a < b ? -1 : 1;
function version(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] } : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return order(a.core[i], b.core[i]);
  if (!a.pre.length || !b.pre.length) return order(Boolean(b.pre.length), Boolean(a.pre.length));
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return order(a.pre.length, b.pre.length);
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    return nx && ny ? order(BigInt(x), BigInt(y)) : nx !== ny ? (nx ? -1 : 1) : order(x, y);
  }
  return 0;
}

// Only advertised tags count. A scratch/local tag can never claim that stale
// pictures were public. The selected ref's own release tag is excluded.
export function previousListing(source, repository) {
  if (!source.repo || !git(source.repo, 'remote').toString().split('\n').includes('origin')) return null;
  const origin = git(source.repo, 'remote', 'get-url', 'origin').toString().trim();
  const remote = /^(?:https:\/\/github\.com\/|git@github\.com:)/.test(origin) ? repository : origin;
  const current = version(source.seed.version);
  if (!current) return null;
  const records = git(source.repo, 'ls-remote', '--tags', remote, 'refs/tags/v*').toString().trim().split('\n').filter(Boolean);
  const refs = new Map(records.map(record => record.split('\t').reverse()));
  const tags = [...refs].filter(([ref]) => !ref.endsWith('^{}')).map(([ref, oid]) => ({ ref, oid, commit: refs.get(ref + '^{}') ?? oid, version: version(ref.slice('refs/tags/'.length)) }))
    .filter(tag => tag.version && compare(tag.version, current) <= 0 && tag.commit !== source.commit)
    .sort((a, b) => compare(a.version, b.version));
  let previous = null;
  for (const tag of tags) {
    // Fetch the advertised object by ID, without changing local tag refs.
    try { git(source.repo, 'cat-file', '-e', `${tag.commit}^{commit}`); }
    catch { git(source.repo, 'fetch', '--no-tags', '--filter=blob:none', remote, tag.oid); }
    const prior = committedSource(source.repo, tag.commit, { hydrateFrom: remote });
    previous = listingContent(prior, repository, previous);
  }
  return previous;
}
