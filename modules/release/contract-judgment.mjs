import { git } from './source.mjs';
import { historicalClauses } from './historical-clauses.mjs';

const stable = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function ordinary(repo, commit, path) {
  const record = git(repo, 'ls-tree', '-z', commit, '--', path).toString();
  const match = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(record);
  if (!match || match[3] !== path) throw Error('Historical release input must be an ordinary blob');
  return { blob: match[2], bytes: git(repo, 'cat-file', 'blob', match[2]) };
}

// Select the nearest lower stable tag before inspecting it. An unusable nearest
// release never permits searching farther back for a convenient old contract.
export function inheritedContract(source, bytes) {
  const current = stable.exec(source.seed.version);
  if (!source.repo || !current || BigInt(current[3]) === 0n) return null;
  const [, major, minor, patch] = current;
  const tags = git(source.repo, 'tag', '--list', `v${major}.${minor}.*`).toString().trim().split('\n')
    .map(tag => ({ tag, version: stable.exec(tag) }))
    .filter(({ tag, version }) => tag.startsWith('v') && version && version[1] === major && version[2] === minor && BigInt(version[3]) < BigInt(patch))
    .sort((a, b) => BigInt(a.version[3]) > BigInt(b.version[3]) ? -1 : 1);
  if (!tags.length) return null;
  const { tag } = tags[0];
  let identity;
  try {
    const commit = git(source.repo, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`).toString().trim();
    // Exported histories replace commit but retain the selected source's blobs
    // and repo. The producer preserves its original SHA for this judgment.
    git(source.repo, 'merge-base', '--is-ancestor', commit, source.contractSourceCommit ?? source.commit);
    const seed = JSON.parse(ordinary(source.repo, commit, 'seed.json').bytes);
    const pkg = JSON.parse(ordinary(source.repo, commit, 'package.json').bytes);
    const release = JSON.parse(ordinary(source.repo, commit, 'RELEASE.json').bytes);
    if (seed.id !== source.seed.id || seed.version !== tag.slice(1) || pkg.version !== seed.version || release.version !== seed.version) return null;
    const previous = ordinary(source.repo, commit, 'CONTRACT.md');
    if (!previous.bytes.equals(bytes)) return null;
    identity = { status: 'PASS', mode: 'inherited', tag, commit, blob: previous.blob };
  } catch {
    // Ineligible history takes the full current validation path. No historical
    // checkout, parser import, script or package installation is performed.
    return null;
  }
  return { clauses: historicalClauses(bytes.toString()), judgment: identity };
}
