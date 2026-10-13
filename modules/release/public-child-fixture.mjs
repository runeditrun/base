import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './test-fixture.mjs';
import { installHttpFixture } from './public-child-http-fixture.cjs';

export const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// API and transport doubles only. All repository construction, installs, seed
// verification, object operations and publication inspections remain real.
export function publicFixture(t, verify) {
  const f = fixture(t, verify);
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bare = resolve(f.temporary, 'public.git');
  git(f.temporary, 'init', '--bare', '-q', bare);
  git(f.repo, 'push', bare, 'HEAD:refs/heads/main');
  const parent = git(f.repo, 'rev-parse', 'HEAD');
  const wrappers = resolve(f.temporary, 'transport'); mkdirSync(wrappers);
  writeFileSync(resolve(wrappers, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const state = resolve(f.temporary, 'transport.json');
  const config = { actualGit, bare, url: f.options.repository, state, visibility: 'public' };
  const configPath = resolve(wrappers, 'config.json');
  const configure = patch => { Object.assign(config, patch); writeFileSync(configPath, JSON.stringify(config)); };
  configure({});
  installHttpFixture(wrappers, configPath);
  writeFileSync(resolve(wrappers, 'git'), `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const { withTransportState } = require(${JSON.stringify(resolve(import.meta.dirname, 'public-child-transport-state.cjs'))});
const c = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}));
let args = process.argv.slice(2);
// Git global options have their own arity. Command arguments (remote names,
// config values, paths) must never be mistaken for the command itself.
function commandIndex() {
  const values = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'];
  const flags = ['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects',
    '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs',
    '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) return i;
    if (values.includes(arg)) { i++; continue; }
    if (flags.includes(arg) || /^(--git-dir|--work-tree|--namespace|--config-env|--attr-source|--exec-path)=/.test(arg)) continue;
    // Query/help options exit before a command; unknown options are Git's error.
    return -1;
  }
  return -1;
}
const commandAt = commandIndex(), command = args[commandAt];
function isUrlQuery() {
  let getUrl = false;
  const valueOptions = ['upload-pack', 'sort', 'server-option'];
  const options = [...valueOptions, 'quiet', 'tags', 'heads', 'branches', 'refs', 'get-url', 'exit-code', 'symref'];
  // ls-remote stops parsing options at the repository (or --). Respect option
  // values and Git's unique long-option abbreviations and boolean negation.
  for (let i = commandAt + 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '--') break;
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0], negate = name.startsWith('no-');
      const matches = options.filter(option => option.startsWith(negate ? name.slice(3) : name));
      if (matches.length !== 1) continue;
      const option = matches[0];
      if (option === 'get-url') getUrl = !negate;
      if (!negate && valueOptions.includes(option) && !arg.includes('=')) i++;
    } else {
      // -o takes the rest of its short-option group, or the next argument.
      const optionAt = arg.indexOf('o');
      if (optionAt === arg.length - 1) i++;
    }
  }
  return getUrl;
}
const mapped = args.slice(commandAt + 1).includes(c.url);
const heads = mapped && command === 'ls-remote' && !isUrlQuery(), fetches = mapped && command === 'fetch';
args = args.map(a => a === c.url ? c.bare : a);
function runGit(state) {
  if (c.corruptTree && command === 'write-tree') {
    const dir = args[args.indexOf('-C') + 1];
    const oid = cp.execFileSync(c.actualGit, ['-C', dir, 'hash-object', '-w', '--stdin'], {input:'corrupted real blob'}).toString().trim();
    cp.execFileSync(c.actualGit, ['-C', dir, 'update-index', '--cacheinfo', '100644', oid, 'README.md']);
  }
  const result = cp.spawnSync(c.actualGit, args, {stdio: heads ? ['inherit','pipe','pipe'] : 'inherit'});
  if (heads && c.unresolvedAfter && state.heads === 2) return 1;
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (heads && (c.ambiguous || (c.ambiguousAfter && state.heads === 2))) process.stdout.write(result.stdout || '');
  return result.status ?? 1;
}
function runTransport() {
  return withTransportState(c.state, state => {
    if (heads) {
      state.heads++;
      if (state.heads === (c.changeAt || 2) && c.moveTo) cp.execFileSync(c.actualGit, ['-C', c.bare, 'update-ref', 'refs/heads/main', c.moveTo]);
      if (state.heads === 2 && c.removeHead) cp.execFileSync(c.actualGit, ['-C', c.bare, 'update-ref', '-d', 'refs/heads/main']);
      if (state.heads === 2 && c.addTag) cp.execFileSync(c.actualGit, ['-C', c.bare, 'update-ref', 'refs/tags/v1.2.3', c.addTag]);
    }
    if (fetches) state.fetches++;
    // Keep the native operation and hooks bound to this invocation's snapshot.
  }, runGit);
}
process.exitCode = heads || fetches ? runTransport() : runGit();
`);
  writeFileSync(resolve(wrappers, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'); const c = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}));
if (c.visibility === 'unresolved') { process.stdout.write('invalid API response'); process.exit(0); }
if (c.visibility === 'missing') { process.stdout.write('HTTP/2 404 Not Found\\n\\n'+JSON.stringify({message:'Not Found', status:'404', documentation_url:'https://docs.github.com/rest/repos/repos'})); process.exit(1); }
process.stdout.write('HTTP/2 200 OK\\n\\n'+JSON.stringify({private:c.visibility !== 'public'}));
`);
  chmodSync(resolve(wrappers, 'git'), 0o755); chmodSync(resolve(wrappers, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = wrappers + ':' + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  return { ...f, bare, parent, configure, state: () => JSON.parse(readFileSync(state)),
    options: { ...f.options, onto: f.options.repository + '#main', tag: 'v1.2.3' } };
}
