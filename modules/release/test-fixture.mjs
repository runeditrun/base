import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const locks = new Map();

export function fixture(t, verify = 'node --test check.test.mjs', packageManager = 'pnpm@10.12.4') {
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'rer-release-producer-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repo = resolve(temporary, 'seed'); mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  const files = {
    'LICENSE': readFileSync(resolve(root, 'LICENSE')),
    'seed.json': JSON.stringify({ id: 'fixture', name: 'Fixture', version: '1.2.3', category: 'status', maturity: 'test-only', description: 'Synthetic producer test.', nonGoals: [], replaces: [], externals: [], extensionPoints: {} }),
    'package.json': JSON.stringify({ name: 'fixture', version: '1.2.3', private: true, type: 'module', packageManager, scripts: { verify } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
    'RELEASE.json': JSON.stringify({ version: '1.2.3' }),
    'CONTRACT.md': '# Fixture\n\n- **TEST-001 — Exact bytes.** Export the verified committed bytes.\n',
    'AGENTS.md': 'Synthetic fixture instructions.\n',
    'README.md': 'Synthetic producer fixture.\n',
    'check.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('committed product guarantee', () => assert.match(readFileSync('CONTRACT.md', 'utf8'), /TEST-001/));\n",
  };
  for (const [path, bytes] of Object.entries(files)) writeFileSync(resolve(repo, path), bytes);
  // Generate the identical empty dependency graph once per manager/file process.
  // Every producer still performs its actual frozen install and verification.
  if (!locks.has(packageManager)) {
    execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    locks.set(packageManager, readFileSync(resolve(repo, 'pnpm-lock.yaml')));
  } else writeFileSync(resolve(repo, 'pnpm-lock.yaml'), locks.get(packageManager));
  files['pnpm-lock.yaml'] = readFileSync(resolve(repo, 'pnpm-lock.yaml'));
  const commit = () => { git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'synthetic fixture', '--allow-empty'); return git(repo, 'rev-parse', 'HEAD'); };
  const sha = commit();
  return { repo, temporary, files, commit, sha, options: { repo, tag: true, output: resolve(temporary, 'release'), project: 'octocat/Hello-World', repository: 'https://github.com/octocat/Hello-World' } };
}
