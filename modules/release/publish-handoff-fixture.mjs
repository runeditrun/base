import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { json, sha256 } from './catalogue.mjs';
import { writePublishHandoff } from './publish-handoff.mjs';

// Build real Git identities without dependency installation or publication.
// The wrappers run the real commands, then inject only their reported exit status.
export function handoffFixture(t) {
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'rer-handoff-status-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const artifact = resolve(temporary, "reviewed 'artifact' $(never-run)");
  const repo = resolve(artifact, 'public-git'), remote = resolve(temporary, 'remote.git');
  const unrelated = resolve(temporary, 'unrelated'), wrappers = resolve(temporary, 'commands');
  for (const path of [repo, unrelated, wrappers]) mkdirSync(path, { recursive: true });
  writeFileSync(resolve(wrappers, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (cwd, ...args) => execFileSync(actualGit, ['-C', cwd, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
    ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '--template=', '-b', 'main');
  writeFileSync(resolve(repo, 'README.md'), 'Public parent.\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Public parent');
  const parent = git(repo, 'rev-parse', 'HEAD');
  git(temporary, 'init', '-q', '--bare', '--template=', remote);
  git(remote, 'fetch', '--quiet', '--no-tags', repo, 'HEAD:refs/heads/main');
  writeFileSync(resolve(repo, 'README.md'), 'Public child.\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'v1.2.3');
  git(repo, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3');
  const commit = git(repo, 'rev-parse', 'HEAD'), tree = git(repo, 'rev-parse', 'HEAD^{tree}');
  const tagObject = git(repo, 'rev-parse', 'refs/tags/v1.2.3');
  const report = json({ status: 'PASS', complete: true });
  const receipt = { publicExport: { commit, tree, tagObject }, publicParent: parent,
    tag: { name: 'v1.2.3' }, gates: { publishCheck: { reportSha256: sha256(report) } } };
  const destination = { url: 'https://github.com/octocat/Hello-World', branch: 'main' };
  writeFileSync(resolve(artifact, 'release-receipt.json'), json(receipt));
  writeFileSync(resolve(artifact, 'publish-check.json'), report);
  writePublishHandoff(artifact, destination, receipt);
  const handoff = readFileSync(resolve(artifact, 'PUBLISH.md'), 'utf8');
  const expected = { receipt: sha256(json(receipt)), report: sha256(report),
    config: sha256(readFileSync(resolve(repo, '.git/config'))), toplevel: repo,
    head: commit, tree, parent: `${commit} ${parent}`, tagType: 'tag', tagObject,
    tagCommit: commit, remote: `${parent}\trefs/heads/main` };
  const trace = resolve(temporary, 'guard-trace.jsonl'), marker = resolve(artifact, 'push-point');
  const configuration = { actualGit, actualNode: process.execPath, remote, url: destination.url, trace };
  for (const kind of ['git', 'node']) {
    const wrapper = resolve(wrappers, kind);
    writeFileSync(wrapper, `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const c = ${JSON.stringify(configuration)}, kind = ${JSON.stringify(kind)};
let args = process.argv.slice(2), label;
if (kind === 'git') {
  if (args.includes('push')) process.exit(98); // Defense in depth: never invoke a push.
  if (args.includes('ls-remote')) label = 'remote';
  else if (args.includes('rev-list')) label = 'parent';
  else if (args.includes('cat-file')) label = 'tagType';
  else if (args.includes('rev-parse')) label = {
    '--show-toplevel': 'toplevel', HEAD: 'head', 'HEAD^{tree}': 'tree',
    'refs/tags/v1.2.3': 'tagObject', 'refs/tags/v1.2.3^{commit}': 'tagCommit'
  }[args.at(-1)];
  args = args.map(arg => arg === c.url ? c.remote : arg);
} else if (args[0] === '-e' && args[1].includes('createHash("sha256")')) {
  label = args.at(-1).endsWith('/release-receipt.json') ? 'receipt'
    : args.at(-1).endsWith('/publish-check.json') ? 'report' : 'config';
}
const result = cp.spawnSync(kind === 'git' ? c.actualGit : c.actualNode, args, { encoding: 'utf8' });
const status = label && label === process.env.HANDOFF_GUARD_FAULT ? 79 : (result.status ?? 1);
if (label) fs.appendFileSync(c.trace, JSON.stringify({ label, stdout: result.stdout, underlyingStatus: result.status, status }) + '\\n');
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
process.exit(status);
`);
    chmodSync(wrapper, 0o755);
  }
  return { artifact, handoff, receipt, destination, expected, run(script, fault = '') {
    rmSync(marker, { force: true }); rmSync(trace, { force: true });
    const result = spawnSync('sh', ['-c', script], { cwd: unrelated, encoding: 'utf8',
      env: { ...env, PATH: `${wrappers}:${env.PATH}`, HANDOFF_GUARD_FAULT: fault } });
    const operations = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    return { ...result, operations, reachedPush: existsSync(marker) };
  } };
}
