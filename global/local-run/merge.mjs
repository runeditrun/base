import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {text as checkoutText} from './process.mjs';
import {recordPath, recordTree} from './upstream-record.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (error_code, message = error_code, prepared) => Object.assign(new Error(message), {error_code, ...(prepared ? {prepared, result: prepared} : {})});
const environment = cwd => ({PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.TMPDIR ? {TMPDIR: process.env.TMPDIR} : {}), HOME: join(cwd, '.rer/upgrade-tools'), LANG: 'C.UTF-8', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'});

function command(cwd, executable, args, {input, allow = [], binary = false, env = {}} = {}) {
  return new Promise((accept, reject) => {
    const child = execFile(executable, args, {cwd, env: {...environment(cwd), ...env}, encoding: binary ? 'buffer' : 'utf8', timeout: 15 * 60_000, maxBuffer: 256 * 1024 * 1024}, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      if (code && !allow.includes(code)) reject(fail('refused', `Update integration command failed (${basename(executable)}${executable === 'git' ? ` ${args[4]}` : ''}, ${code})`));
      else accept({stdout, stderr, code});
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const git = (cwd, args, options) => command(cwd, 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], options);
const text = async (cwd, args, options) => (await git(cwd, args, options)).stdout.trim();
const revision = (cwd, ref) => text(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
const paths = async (cwd, from, to) => (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', from, to, '--'])).stdout.split('\0').filter(Boolean);
const entries = async (cwd, tree) => new Map((await git(cwd, ['ls-tree', '-r', '-z', tree])).stdout.split('\0').filter(Boolean).map(record => {
  const tab = record.indexOf('\t'), [mode, type, oid] = record.slice(0, tab).split(' ');
  return [record.slice(tab + 1), {mode, type, oid}];
}));
const blob = async (cwd, oid) => (await git(cwd, ['cat-file', 'blob', oid], {binary: true})).stdout;
const jsonAt = async (cwd, files, path) => files.has(path) ? JSON.parse((await blob(cwd, files.get(path).oid)).toString('utf8')) : {};

// Kept in step with platform src/updates/source-lock.mjs. The signed target's
// manifest authorizes automatic resolution; a conflicted manifest cannot do so.
function sourceLockCommand(scripts = {}) {
  if (scripts['source:lock']) return 'source:lock';
  if (scripts.sources) return 'sources lock';
  const name = Object.keys(scripts).sort().find(key => typeof scripts[key] === 'string' && /^node (?:\.\/)?scripts\/edition-authoring\/cli\.mjs$/.test(scripts[key].trim()));
  return name ? `${name} lock` : null;
}

async function migrations(cwd, head, candidate) {
  const [before, after] = await Promise.all([entries(cwd, head), entries(cwd, candidate)]);
  const isMigration = path => /(?:^|\/)migrations\/.*\.sql$/i.test(path);
  const added = [], declarations = new Map();
  for (const path of [...new Set([...before.keys(), ...after.keys()])].filter(isMigration)) {
    const old = before.get(path), next = after.get(path), name = basename(path);
    if (!/^[\w.-]+\.sql$/.test(name) || next && (next.type !== 'blob' || !/^100/.test(next.mode))) throw fail('migration_history_changed');
    if (!old) { added.push(name); continue; }
    if (!next) throw fail('migration_history_changed');
    if (old.oid === next.oid && old.mode === next.mode) continue;
    if (old.mode !== next.mode) throw fail('migration_history_changed');
    const root = path.slice(0, path.indexOf('migrations/') + 'migrations/'.length), declarationPath = `${root}rewrites.json`;
    if (!declarations.has(root)) {
      let document;
      try { document = await jsonAt(cwd, after, declarationPath); } catch { throw fail('migration_history_changed'); }
      const records = document.rewrites;
      if (document.version !== 1 || Object.keys(document).some(key => !['version', 'rewrites'].includes(key)) || !Array.isArray(records) || records.length > 1000) throw fail('migration_history_changed');
      const seen = new Set();
      for (const item of records) {
        const key = `${item?.migration} ${item?.from}`;
        if (!item || Object.keys(item).some(key => !['migration', 'from', 'to', 'reason', 'reviewed'].includes(key)) || !/^[0-9]+_[a-zA-Z0-9_-]+\.sql$/.test(item.migration ?? '') || !/^[a-f0-9]{64}$/.test(item.from ?? '') || !/^[a-f0-9]{64}$/.test(item.to ?? '') || item.from === item.to || item.reviewed !== true || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000 || seen.has(key)) throw fail('migration_history_changed');
        seen.add(key);
        const matches = [...after].filter(([file]) => file.startsWith(root) && isMigration(file) && basename(file) === item.migration);
        if (matches.length !== 1 || sha(await blob(cwd, matches[0][1].oid)) !== item.to) throw fail('migration_history_changed');
      }
      declarations.set(root, records);
    }
    const [from, to] = await Promise.all([blob(cwd, old.oid).then(sha), blob(cwd, next.oid).then(sha)]);
    if (!declarations.get(root).some(item => item.migration === name && item.from === from && item.to === to)) throw fail('migration_history_changed');
  }
  return [...new Set(added)].sort();
}

async function safeWorktree(checkout, tag) {
  const root = await realpath(checkout);
  let directory = root;
  for (const part of ['.rer', 'upgrade', 'integration']) {
    directory = join(directory, part);
    await mkdir(directory, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('refused');
  }
  return join(directory, `${tag.replace(/[^\w.-]/g, '-').slice(0, 70)}-${sha(tag).slice(0, 12)}`);
}

async function regenerateLock(worktree, expected) {
  await mkdir(join(worktree, '.rer/upgrade-tools'), {recursive: true, mode: 0o700});
  const pkg = JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8'));
  const lock = sourceLockCommand(pkg.scripts);
  if (!lock || lock !== expected) throw fail('refused', 'Integration changed the declared source lock command');
  // Dependency installation is isolated and frozen, and receives no credentials.
  // Projects whose authoring script uses only Node need no dependency install.
  if (Object.keys({...pkg.dependencies, ...pkg.devDependencies}).length) {
    const exists = async path => lstat(join(worktree, path)).then(stat => stat.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; });
    if (await exists('pnpm-lock.yaml') && /^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/.test(pkg.packageManager ?? '')) await command(worktree, 'npx', ['--yes', pkg.packageManager.split('+')[0], 'install', '--frozen-lockfile']);
    else if (await exists('package-lock.json')) await command(worktree, 'npm', ['ci']);
    else if (await exists('yarn.lock') && /^yarn@\d+\.\d+\.\d+(?:\+.*)?$/.test(pkg.packageManager ?? '')) await command(worktree, 'corepack', ['yarn', 'install', '--immutable']);
    else throw fail('refused', 'Source lock regeneration requires frozen dependencies');
  }
  await command(worktree, process.execPath, lock.endsWith(' lock') ? ['--run', lock.slice(0, -5), '--', 'lock'] : ['--run', lock]);
  await git(worktree, ['add', '-A']);
}

async function noMarkers(worktree, tree) {
  if (!tree && await text(worktree, ['ls-files', '--unmerged'])) throw fail('needs_integration');
  const found = await git(worktree, ['grep', '-I', '-l', '-E', '^(<<<<<<<( |$)|=======$|>>>>>>>( |$)|[|]{7}( |$))', ...(tree ? [tree] : []), '--', '.', ':(exclude)rer-upstream.json'], {allow: [1]});
  if (found.code === 0) throw fail('needs_integration');
}

async function originalUnchanged(checkout, prepared) {
  const [head, branch] = await Promise.all([revision(checkout, 'HEAD'), text(checkout, ['symbolic-ref', '--quiet', 'HEAD'])]);
  if (head !== prepared.head || branch !== prepared.original_branch) throw fail('refused', 'Checkout changed since update preparation');
}

const fingerprint = async worktree => sha(Buffer.concat(await Promise.all([
  git(worktree, ['diff', '--binary', 'HEAD'], {binary: true}).then(r => r.stdout),
  git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {binary: true}).then(r => r.stdout),
])));

async function candidateCommit(checkout, prepared, tree) {
  tree = await recordTree(checkout, tree, {repository: prepared.repository, tag: prepared.tag, commit: prepared.target});
  await noMarkers(checkout, tree);
  const migrations_applied = await migrations(checkout, prepared.head, tree);
  const ancestor = await git(checkout, ['merge-base', '--is-ancestor', prepared.target, prepared.head], {allow: [1]});
  const parents = ['-p', prepared.head, ...(ancestor.code ? ['-p', prepared.target] : [])];
  // Attribute the local integration to this checkout's configured Git identity.
  // It stays in local Git metadata and is never included in device events.
  const configured = /^(.*) <([^<>\r\n]+)> \d+ [+-]\d{4}$/.exec(await checkoutText(checkout, ['var', 'GIT_AUTHOR_IDENT']));
  if (!configured) throw fail('needs_input', 'Configure a Git author before integrating the release');
  const env = {GIT_AUTHOR_NAME: configured[1], GIT_AUTHOR_EMAIL: configured[2], GIT_COMMITTER_NAME: configured[1], GIT_COMMITTER_EMAIL: configured[2]};
  const candidate = await text(checkout, ['commit-tree', tree, ...parents, '-m', `Update to ${prepared.tag}`], {env});
  await originalUnchanged(checkout, prepared);
  return {...prepared, status: 'prepared', candidate, migrations_applied, conflicts: {public_paths: [], other_count: 0}};
}

/** Only Git objects and the separate update worktree change before the switch. */
export async function prepareMerge({checkout, base, head, target, tag, repository}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || typeof tag !== 'string' || !tag || tag.length > 200) throw fail('refused');
  [base, head, target] = await Promise.all([revision(checkout, base), revision(checkout, head), revision(checkout, target)]);
  const original_branch = await text(checkout, ['symbolic-ref', '--quiet', 'HEAD']);
  const branch = `rer/update-${tag}`;
  await git(checkout, ['check-ref-format', '--branch', branch]);
  const prepared = {head, base, target, tag, repository, branch, original_branch, owner_changes_kept: (await paths(checkout, base, head)).filter(path => path !== recordPath).length, migrations_applied: [], conflicts: {public_paths: [], other_count: 0}};
  await originalUnchanged(checkout, prepared);
  for (const descendant of [head, target]) if ((await git(checkout, ['merge-base', '--is-ancestor', base, descendant], {allow: [1]})).code) throw fail('refused');
  if (!(await git(checkout, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {allow: [1]})).code) throw fail('refused', 'An update branch already exists');
  const merged = await git(checkout, ['merge-tree', '--write-tree', '-z', '--no-messages', `--merge-base=${base}`, head, target], {allow: [1]});
  const [tree, ...records] = merged.stdout.split('\0');
  if (!/^[a-f0-9]{40,64}$/.test(tree)) throw fail('refused');
  const stages = records.filter(Boolean), allConflicts = [...new Set(stages.map(record => record.slice(record.indexOf('\t') + 1)))];
  const targetFiles = await entries(checkout, target);
  let lock = null;
  try { lock = sourceLockCommand((await jsonAt(checkout, targetFiles, 'package.json')).scripts); } catch { /* Invalid target manifests cannot authorize lock resolution. */ }
  const remaining = allConflicts.filter(path => path !== recordPath && (path !== 'sources.lock.json' || !lock));
  const publicPaths = remaining.filter(path => targetFiles.has(path)).sort();
  prepared.conflicts = {public_paths: publicPaths.slice(0, 50), other_count: remaining.length - Math.min(publicPaths.length, 50)};
  prepared.source_lock_command = lock;
  if (!remaining.length && !lock) {
    const result = await candidateCommit(checkout, prepared, tree);
    await git(checkout, ['update-ref', `refs/heads/${branch}`, result.candidate, '']);
    return result;
  }
  prepared.worktree = await safeWorktree(checkout, tag);
  await git(checkout, ['worktree', 'add', '--quiet', '-b', branch, prepared.worktree, head]);
  try {
    await git(prepared.worktree, ['read-tree', '--reset', '-u', tree]);
    if (lock && allConflicts.includes('sources.lock.json')) await git(prepared.worktree, ['checkout', target, '--', 'sources.lock.json']);
    if (remaining.length) {
      // merge-tree's tree contains conflict markers; preserve its real index stages
      // as well so an integration agent can use the ordinary Git resolution flow.
      const input = [...remaining.map(path => `0 ${'0'.repeat(head.length)}\t${path}`), ...stages.filter(record => remaining.includes(record.slice(record.indexOf('\t') + 1)))].join('\0') + '\0';
      await git(prepared.worktree, ['update-index', '-z', '--index-info'], {input});
      prepared.status = 'needs_integration';
      prepared.integration_fingerprint = await fingerprint(prepared.worktree);
      await originalUnchanged(checkout, prepared);
      throw fail('needs_integration', 'Resolve the prepared update worktree and commit the integration', prepared);
    }
    await regenerateLock(prepared.worktree, lock);
    await noMarkers(prepared.worktree);
    const result = await candidateCommit(checkout, prepared, await text(prepared.worktree, ['write-tree']));
    await git(prepared.worktree, ['reset', '--hard', result.candidate]);
    return {...result, integration_fingerprint: await fingerprint(prepared.worktree)};
  } catch (error) {
    prepared.integration_fingerprint ??= await fingerprint(prepared.worktree);
    error.prepared ??= prepared; error.result ??= prepared;
    throw error;
  }
}

/** The integration agent commits its resolution; the caller checkout stays put. */
export async function continueMerge({checkout, ...prepared}) {
  await originalUnchanged(checkout, prepared);
  if (!prepared.worktree || resolve(prepared.worktree) !== await safeWorktree(checkout, prepared.tag)) throw fail('refused');
  if (await text(prepared.worktree, ['symbolic-ref', '--quiet', 'HEAD']) !== `refs/heads/${prepared.branch}`) throw fail('refused');
  if ((await git(prepared.worktree, ['merge-base', '--is-ancestor', prepared.head, 'HEAD'], {allow: [1]})).code) throw fail('refused');
  await noMarkers(prepared.worktree);
  if (await text(prepared.worktree, ['status', '--porcelain', '--untracked-files=all'])) throw fail('needs_integration', 'Commit the resolved integration before continuing', prepared);
  if (prepared.source_lock_command) await regenerateLock(prepared.worktree, prepared.source_lock_command);
  await noMarkers(prepared.worktree);
  const result = await candidateCommit(checkout, prepared, await text(prepared.worktree, ['write-tree']));
  await git(prepared.worktree, ['reset', '--hard', result.candidate]);
  return {...result, integration_fingerprint: await fingerprint(prepared.worktree)};
}

/** Delete only the worktree/ref this preparation owns; preserve later edits. */
export async function cleanupMerge(checkout, prepared) {
  const expected = prepared.candidate ?? prepared.head;
  const ref = `refs/heads/${prepared.branch}`;
  if (await revision(checkout, ref) !== expected) throw fail('refused', 'Update branch contains later integration work');
  if (prepared.worktree) {
    if (resolve(prepared.worktree) !== await safeWorktree(checkout, prepared.tag) || !prepared.integration_fingerprint || await fingerprint(prepared.worktree) !== prepared.integration_fingerprint) throw fail('refused', 'Integration worktree contains later edits');
    await git(checkout, ['worktree', 'remove', '--force', prepared.worktree]);
  }
  await git(checkout, ['update-ref', '-d', ref, expected]);
}
