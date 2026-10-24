import { execFile, spawn } from 'node:child_process';
import { appendFile, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { invalid, refuse } from '../../cli/errors.mjs';

const git = promisify(execFile);

function repository(value) {
 if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`;
 if (/^(?:https?|ssh|git|file):\/\//.test(value) || /^[\w.-]+@[\w.-]+:.+/.test(value)) return value;
 throw invalid('Use owner/repo, a GitHub HTTPS URL, or a git URL.');
}

function identity(value, cwd) {
 const scp = /^[\w.-]+@([^:]+):(.+)$/.exec(value);
 let host, path;
 if (scp) [, host, path] = scp;
 else {
  let url;
  try { url = new URL(value); } catch { return resolve(cwd, value); }
  if (url.protocol === 'file:') return resolve(fileURLToPath(url));
  host = url.hostname.toLowerCase() + (url.port ? `:${url.port}` : ''); path = url.pathname;
 }
 path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
 return `${host.toLowerCase()}/${host.toLowerCase() === 'github.com' ? path.toLowerCase() : path}`;
}

export function repoArguments(argv) {
 // Existing invocations without a repository are dispatched unchanged.
 if (!['dev', 'setup', 'install'].includes(argv[0]) || !argv[1] || argv[1].startsWith('-')) return undefined;
 const url = repository(argv[1]), args = [], cwd = process.cwd();
 let directory, release, anchors;
 for (let i = 2; i < argv.length; i++) {
  if (['--release', '--anchors'].includes(argv[i])) {
   const flag = argv[i], value = argv[++i];
   if (argv[0] !== 'dev') throw invalid(`${flag} is supported with rer dev <repo>.`);
   if (!value?.trim() || value.startsWith('-')) throw invalid(`A value is required for ${flag}.`);
   if (flag === '--release') {
    if (release !== undefined) throw invalid('Use --release only once.');
    release = value;
   } else {
    if (anchors !== undefined) throw invalid('Use --anchors only once.');
    anchors = resolve(cwd, value);
   }
   continue;
  }
  if (argv[i] !== '--dir') { args.push(argv[i]); continue; }
  if (directory !== undefined) throw invalid('Use --dir only once.');
  directory = argv[++i];
  if (!directory?.trim() || directory.startsWith('-')) throw invalid('A folder is required for --dir.');
 }
 if (anchors && !release) throw invalid('--anchors requires --release.');
 if (args.includes('--cwd')) throw invalid('Use --dir with a repository, or --cwd inside a checkout.');
 const name = basename(url.replace(/\/+$/, '').replace(/\.git$/, ''));
 if (!name || ['.', '..'].includes(name) || /[?#\\]/.test(name)) throw invalid('The git URL must name a repository.');
 return { verb: argv[0], url, args, root: resolve(cwd, directory ?? name), directory: directory ?? name, ...(release ? { release } : {}), ...(anchors ? { anchors } : {}) };
}

export async function checkoutRepository({ url, root, directory, release, anchors, quiet = false }) {
 const conflict = () => refuse(`Folder ${directory} is not an empty folder or a clone of this repository. Choose another folder with --dir DIR.`);
 let info;
 try { info = await lstat(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
 if (info) {
  if (!info.isDirectory() && !info.isSymbolicLink()) throw conflict();
  let entries;
  try { entries = await readdir(root); } catch { throw conflict(); }
  if (entries.length) {
   try {
    const [{ stdout: origin }, { stdout: top }] = await Promise.all([
     git('git', ['-C', root, 'config', '--get', 'remote.origin.url']),
     git('git', ['-C', root, 'rev-parse', '--show-toplevel']),
    ]);
    if (await realpath(root) === await realpath(top.trim()) && identity(origin.trim(), root) === identity(url, process.cwd())) {
     return release ? await selectRelease({ root, release, anchors, fresh: false }) : undefined;
    }
   } catch (error) { if (error.error_code) throw error; /* A non-clone is refused by the same single-line message. */ }
   throw conflict();
  }
 }
 await mkdir(resolve(root, '..'), { recursive: true });
 // Every commit and release tag, so `git checkout <tag>` adopts an older
 // release; file contents arrive when a checkout needs them (a host without
 // partial clone sends them all).
 const args = ['clone', '--filter=blob:none', ...(release ? ['--no-checkout'] : []), '--', url, root];
 const code = quiet ? (await (await import('../local-run/process.mjs')).run('git', args)).code : await runCommand('git', args);
 if (code !== 0) throw refuse(`Could not clone into ${directory}. Check the git URL and access, then rerun the command.`);
 return release ? await selectRelease({ root, release, anchors, fresh: true }) : undefined;
}

// Only a clone acquired by this invocation can move its branch. Repeated
// setup preserves the owner's branch, commits and working files.
async function selectRelease({ root, release, anchors, fresh }) {
 const [{ resolveRelease, recordedRelease }, { text, git: command }, { failure }] = await Promise.all([
  import('../local-run/release.mjs'), import('../local-run/process.mjs'), import('../local-run/error.mjs'),
 ]);
 const verified = await resolveRelease({ checkout: root, to: release, anchors, fresh });
 if (fresh) {
  const branch = await command(root, ['symbolic-ref', '--quiet', 'HEAD'], { allow: [1] });
  if (branch.code !== 0) throw failure('not_on_branch');
  await text(root, ['reset', '--hard', verified.commit]);
 } else {
  const [head, saved] = await Promise.all([text(root, ['rev-parse', 'HEAD']), recordedRelease(root).catch(error => {
   if (error.error_code === 'release_not_found') return null;
   throw error;
  })]);
  const same = saved?.repository === verified.repository && saved?.commit === verified.commit;
  const descends = await command(root, ['merge-base', '--is-ancestor', verified.commit, head], { allow: [1, 128] });
  if (head !== verified.commit && (!same || descends.code !== 0)) throw failure('refused');
 }
 const tracked = await text(root, ['ls-files', '--', '.rer/release.json']);
 if (tracked) throw failure('refused');
 for (const path of [resolve(root, '.rer'), resolve(root, '.rer/release.json')]) {
  try { if ((await lstat(path)).isSymbolicLink()) throw failure('refused'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
 }
 const ignored = await command(root, ['check-ignore', '--quiet', '.rer/'], { allow: [1] });
 if (ignored.code !== 0) {
  const exclude = resolve(root, await text(root, ['rev-parse', '--git-path', 'info/exclude']));
  await mkdir(resolve(exclude, '..'), { recursive: true });
  await appendFile(exclude, '\n/.rer/\n');
  if ((await command(root, ['check-ignore', '--quiet', '.rer/'], { allow: [1] })).code !== 0) throw failure('refused');
 }
 await mkdir(resolve(root, '.rer'), { recursive: true, mode: 0o700 });
 const record = { repository: verified.repository, tag: verified.tag, commit: verified.commit, verified_at: verified.verified_at };
 await writeFile(resolve(root, '.rer/release.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
 return verified;
}

// Preserve normal dev foreground/detached behaviour and forward interrupts to
// the child while it is installing, setting up or serving.
export async function runCommand(command, args, options = {}) {
 const { onInterrupt, ...spawnOptions } = options;
 const child = spawn(command, args, { ...spawnOptions, stdio: 'inherit' });
 let interrupted;
 const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { interrupted ??= signal; child.kill(signal); }]));
 for (const [signal, handler] of handlers) process.on(signal, handler);
 try {
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 143))); });
  if (interrupted) await onInterrupt?.();
  return interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : code;
 } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}
