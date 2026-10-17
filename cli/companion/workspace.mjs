import { sandboxCommand } from './providers/sandbox.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, delimiter } from 'node:path';
import { realpathSync, accessSync, constants } from 'node:fs';
const exec = promisify(execFile);
export function approvedGit() {
  const configured = process.env.RER_LOCAL_GIT;
  if (!configured) return { command: 'git', path: process.env.PATH };
  if (!isAbsolute(configured)) throw new Error('RER_LOCAL_GIT must be an absolute executable path.');
  const command = realpathSync(configured);
  accessSync(command, constants.X_OK);
  return { command, path: dirname(command) + delimiter + process.env.PATH };
}
// Preparation reads the approved source checkout, but must not run host-global
// filters, templates, hooks, or environment-injected Git configuration.
export async function git(cwd, ...args) {
  const selected = approvedGit();
  const env = { PATH: selected.path, LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TEMPLATE_DIR: '' };
  return (await exec(selected.command, ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}
export async function prepareWorkspace(mapping, job, stateRoot) {
  if (!mapping || mapping.repository !== job.repository) throw new Error('Job repository does not match locally approved mapping.');
  const checkout = await realpath(mapping.checkout);
  const remote = await git(checkout, 'remote', 'get-url', 'origin');
  if (remote !== mapping.remote) throw new Error('Checkout origin changed; approve its mapping locally again.');
  if (!/^[a-f0-9]{40}$/.test(job.base_commit)) throw new Error('Expected an exact 40-character base commit.');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(job.id)) throw new Error('Invalid job identity.');
  if (await git(checkout, 'rev-parse', `${job.base_commit}^{commit}`) !== job.base_commit) throw new Error('Base commit missing from approved checkout. Fetch it locally first.');
  await mkdir(join(stateRoot, 'worktrees'), { recursive: true, mode: 0o700 });
  const worktree = join(stateRoot, 'worktrees', job.id);
  // Private object/index storage keeps provider Git operations inside the read/write fence.
  // Fetch exactly the approved commit; never copy dirty files or share owner Git metadata.
  await mkdir(worktree, { mode: 0o700 });
  await git(worktree, 'init', '--template=');
  // A mapped Managed checkout may itself be shallow. Fetch the exact pinned
  // commit as a shallow root so Git does not reject the source's shallow
  // boundary while leaving FETCH_HEAD empty.
  await git(worktree, 'fetch', '--no-tags', '--depth=1', checkout, job.base_commit);
  await git(worktree, 'checkout', '--detach', 'FETCH_HEAD');
  await git(worktree, 'remote', 'add', 'origin', mapping.remote);
  return { worktree, baseCommit: job.base_commit };
}
export async function collectResult(workspace, summary, env) {
  const {worktree, baseCommit} = workspace;
  // Staging in the isolated worktree includes new files without touching the owner's index.
  const run=scopedGit(worktree,env);
  await run(['add','--all']);
  const patch = (await run(['diff','--cached','--binary',baseCommit],{maxBuffer:2*1024*1024})).stdout;
  if (!patch) throw new Error('No source patch produced; review the provider result before resuming.');
  if (Buffer.byteLength(patch) > 2 * 1024 * 1024) throw new Error('Patch exceeds 2 MiB relay limit; retain worktree for explicit artifact transfer.');
  const files=await collectFiles(worktree,baseCommit,run);
  return { files, base_commit: baseCommit, commit: (await run(['rev-parse','HEAD'])).stdout.trim(), patch, summary: summary.slice(0, 16000), verification: [await verifyPatch(run)], delivery: 'local' };
}
export function executorEnvironment(provider, home) {
  const env = { PATH: approvedGit().path, HOME: home, TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8' };
  if (provider === 'codex') env.CODEX_HOME = join(home, '.codex');
  if (provider === 'claude') {
    // Claude Code reads OAuth subscription state from the dedicated HOME
    // (installed by `claude-auth`). An API key remains an explicit alternative
    // for operators who choose provider billing; it is never inferred from a
    // host-wide environment or sent through the management relay.
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  return env;
}

async function verifyPatch(run) {
  try { await run(['diff','--cached','--check']); return {command:'git diff --cached --check',exit_code:0}; }
  catch(error) { return {command:'git diff --cached --check',exit_code:error.code||1}; }
}

async function collectFiles(cwd,base,run) {
 const changed=(await run(['diff','--cached','--name-only','-z',base])).stdout.split('\0').filter(Boolean);
 const files=[];
 for(const path of changed){
  const entry=(await run(['ls-files','--stage','--',path])).stdout;
  if(!entry){files.push({path,operation:'delete',mode:'100644'});continue;}
  const mode=entry.split(' ')[0];if(!['100644','100755'].includes(mode))throw new Error('Only regular source files are supported in a publication; review symlinks/submodules locally.');
  const bytes=(await run(['show',`:${path}`],{encoding:'buffer',maxBuffer:2*1024*1024})).stdout;
  files.push({path,operation:'upsert',mode,contentBase64:bytes.toString('base64')});
 }
 return files;
}

function scopedGit(cwd,env) {
 const sandbox=sandboxCommand('git',cwd,env);
 return (args,options={})=>exec(sandbox.command,[...sandbox.args,'-c','core.hooksPath=/dev/null',...args],{cwd,env:sandbox.env,maxBuffer:16*1024*1024,...options});
}
