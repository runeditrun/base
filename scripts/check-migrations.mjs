#!/usr/bin/env node
// Published SQL is a database's history. Compare bytes, including removals,
// with the latest advertised rer release and the commits a change replaces.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const roots = ['default-seed/migrations/', 'foundation/template/migrations/'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const protectedPath = value => typeof value === 'string' && roots.some(root => value.startsWith(root)) && !value.split('/').some(part => !part || part === '..' || part === '.');

function check(repo, extraBase) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
    env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'}, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const text = (...args) => git(...args).toString('utf8').trim();
  const ensure = revision => {
    if (!commit(revision)) throw Error('Migration baseline must be a full commit ID.');
    try { git('cat-file', '-e', `${revision}^{commit}`); }
    catch { git('fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--filter=blob:none', '--depth=1', 'origin', revision); }
    if (text('rev-parse', `${revision}^{commit}`) !== revision) throw Error('Migration baseline is not a commit.');
    return revision;
  };
  // Local tags alone cannot establish which release was published. Resolve the
  // advertised annotated tag without changing local refs, also in shallow CI.
  const advertised = new Map(text('ls-remote', '--tags', 'origin', 'refs/tags/rer-v*').split('\n').filter(Boolean).map(line => line.split('\t').reverse()));
  const versions = [...advertised.keys()].filter(ref => /^refs\/tags\/rer-v\d+\.\d+\.\d+$/.test(ref))
    .map(ref => ({ref, parts: ref.slice('refs/tags/rer-v'.length).split('.').map(BigInt)}))
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? -1 : 1;
      return 0;
    });
  if (!versions.length) throw Error('No published rer-v* release tag available from origin.');
  const release = versions[0].ref;
  const baselines = new Map([[ensure(advertised.get(release + '^{}') ?? advertised.get(release)), release]]);
  const add = (revision, label) => { if (revision && !/^0+$/.test(revision)) baselines.set(ensure(revision), label); };
  // Raw commit headers retain parent IDs even when the checkout is shallow.
  add(/^parent ([a-f0-9]{40})$/m.exec(text('cat-file', '-p', 'HEAD'))?.[1], 'HEAD parent');
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (process.env.GITHUB_EVENT_NAME === 'push') add(event.before, 'push before');
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') add(event.pull_request?.base?.sha, 'pull request base');
  }
  if (extraBase) add(extraBase, 'explicit base');

  const exceptionPath = path.join(repo, 'scripts/migration-exceptions.json');
  const exceptions = JSON.parse(fs.readFileSync(exceptionPath, 'utf8'));
  if (!Array.isArray(exceptions) || exceptions.some(item => !item || !commit(item.baseline) || !protectedPath(item.path) || !digest(item.before) ||
    !(item.after === null || digest(item.after)) || typeof item.reason !== 'string' || !item.reason.trim())) throw Error('Invalid migration exception: require baseline, path, before, after and reason.');
  const changes = [], allowed = [];
  let compared = 0;
  for (const [baseline, label] of baselines) {
    const entries = git('ls-tree', '-rz', baseline, '--', ...roots).toString('utf8').split('\0').filter(Boolean);
    for (const entry of entries) {
      const [metadata, name] = entry.split('\t'), [, type, object] = metadata.split(' ');
      if (type !== 'blob') throw Error(`Migration baseline contains a non-file: ${name}`);
      const before = hash(git('cat-file', 'blob', object));
      let after = null;
      try {
        // Refuse directory/symlink replacements, including linked ancestors.
        let target = repo;
        for (const part of name.split('/')) { target = path.join(target, part); if (fs.lstatSync(target).isSymbolicLink()) throw Error(`Migration path is a symlink: ${name}`); }
        if (!fs.lstatSync(target).isFile()) throw Error(`Migration path is not a file: ${name}`);
        after = hash(fs.readFileSync(target));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      compared++;
      if (before === after) continue;
      const change = {path: name, baseline, source: label, before, after};
      const exception = exceptions.find(item => item.baseline === baseline && item.path === name && item.before === before && item.after === after);
      if (exception) allowed.push({...change, reason: exception.reason}); else changes.push(change);
    }
  }
  return {ok: changes.length === 0, release, baselines: [...baselines].map(([commit, source]) => ({commit, source})), compared, changes, exceptions: allowed,
    next: changes.length ? 'Restore published bytes and add a NEW numbered migration. Exceptional history corrections require an exact reviewed entry in scripts/migration-exceptions.json; see foundation/README.md.' : 'Published migrations are unchanged; new numbered migrations are allowed.'};
}

try {
  const args = process.argv.slice(2);
  let repo = path.resolve(import.meta.dirname, '..'), extraBase;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw Error('Usage: node scripts/check-migrations.mjs [--repo DIR] [--base-ref FULL_COMMIT]');
    if (args[i] === '--repo') repo = path.resolve(args[i + 1]);
    else if (args[i] === '--base-ref') extraBase = args[i + 1];
    else throw Error('Usage: node scripts/check-migrations.mjs [--repo DIR] [--base-ref FULL_COMMIT]');
  }
  const report = check(repo, extraBase);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  // Git diagnostics may include private transport details. Name only the repair.
  const message = error.status !== undefined ? 'Cannot acquire migration history from origin. Restore Git access and rerun; no comparison was skipped.' : error.message;
  console.error(`Migration history check failed: ${message}`);
  process.exitCode = 1;
}
