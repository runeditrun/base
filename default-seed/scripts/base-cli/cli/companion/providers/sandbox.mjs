import { existsSync, realpathSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, delimiter, resolve } from 'node:path';

function executable(name, env, cwd) {
  const path = name.includes('/') ? resolve(cwd,name) : env.PATH.split(delimiter).map(dir => join(dir, name)).find(existsSync);
  if (!path) throw new Error(`Required local executable missing: ${name}`);
  return realpathSync(path);
}

// The boundary wraps the provider itself: built-in reads and subprocesses both inherit it.
// Do not replace this with a provider workspace-write setting (which permits global reads).
// Other platforms refuse before any job is claimed; nothing runs unconfined.
export function assertSandboxPlatform() {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('Local engineering requires the supported macOS sandbox-exec boundary. rer companion run works only on macOS; it never runs a provider without that boundary.');
}

export function sandboxCommand(provider, cwd, env) {
  assertSandboxPlatform();
  const home = realpathSync(env.HOME), workspace = realpathSync(cwd);
  if (home === '/' || workspace === '/' || home === process.env.HOME || workspace === process.env.HOME) throw new Error('An isolated provider home and selected workspace are required.');
  const tmp = join(home, 'tmp'); mkdirSync(tmp, {recursive:true,mode:0o700});
  const cli = executable(provider,env,cwd), node = realpathSync(process.execPath), git = executable('git',env,cwd);
  const roots = [workspace,home,'/System/Library','/private/var/db/timezone','/usr/lib','/usr/share','/usr/bin','/bin','/sbin','/usr/sbin','/Library/Apple/System/Library','/Library/Developer/CommandLineTools',...[node,git].map(path=>dirname(dirname(path))).filter(path=>!['/','/usr'].includes(path))];
  // npm Codex's launcher loads its own package and platform binary package.
  if (/\.(?:mjs|cjs|js)$/.test(cli)) roots.push(dirname(dirname(cli)));
  const libraries = new Set();
  const inspected = new Set();
  const inspect = binary => {
    const canonical=realpathSync(binary);
    if (inspected.has(canonical)) return; inspected.add(canonical); libraries.add(binary); libraries.add(canonical);
    const output = execFileSync('/Library/Developer/CommandLineTools/usr/bin/otool',['-L',binary],{encoding:'utf8'});
    for (const line of output.split('\n').slice(1)) {
      const dependency=line.trim().split(' (')[0];
      let resolved=dependency;
      if (dependency.startsWith('@loader_path/')) resolved=join(dirname(binary),dependency.slice('@loader_path/'.length));
      else if (dependency.startsWith('@rpath/')) resolved=join(dirname(binary),dependency.slice('@rpath/'.length));
      if (resolved.startsWith('/') && !resolved.startsWith('/System/') && !resolved.startsWith('/usr/lib/') && existsSync(resolved)) { libraries.add(resolved); inspect(realpathSync(resolved)); }
    }
  };
  inspect(node); inspect(git);
  if (!/\.(?:mjs|cjs|js)$/.test(cli)) inspect(cli);
  const literals = ['/',...libraries,cli,node,'/dev/null','/dev/urandom','/dev/random','/private/etc/resolv.conf','/private/etc/hosts','/private/etc/localtime','/private/etc/services','/private/etc/protocols','/private/var/run/resolv.conf','/private/var/db/timezone/zoneinfo'];
  const quote = JSON.stringify;
  // Codex 0.163+ loads macOS managed preferences at thread start and fails
  // without read access to the preferences daemon's two shared pages (change
  // counters, no preference values): the daemon's and this user's. No file opens.
  const cfprefs = ['daemonv1', `${process.getuid()}v1`].map(name => `(ipc-posix-name ${quote(`apple.cfprefs.${name}`)})`).join(' ');
  // Network stays open: providers and package managers need outbound access and
  // dev servers need to listen. sandbox-exec cannot confine listening to
  // loopback (a "localhost" network-inbound rule still allows 0.0.0.0).
  // Keep the loader spelling for libraries as well as their canonical targets:
  // macOS may resolve an @loader_path dependency through a versioned symlink,
  // then ask the sandbox for that symlink path during dyld startup.
  const reads = roots.filter(existsSync).map(path => `(subpath ${quote(realpathSync(path))})`).concat(literals.filter(existsSync).map(path => `(literal ${quote(path)})`));
  const profile = `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow signal (target same-sandbox))(allow process-info* (target same-sandbox))(allow sysctl-read)(allow mach-lookup)(allow ipc-posix-shm-read-data ${cfprefs})(allow network*)(allow file-read-metadata)(allow file-read* file-map-executable ${reads.join(' ')})(allow file-write* (subpath ${quote(workspace)}) (subpath ${quote(home)}) (literal "/dev/null"))`;
  return {command:'/usr/bin/sandbox-exec',args:['-p',profile,...(/\.(?:mjs|cjs|js)$/.test(cli)?[node,cli]:[cli])],env:{...env,GIT_CONFIG_NOSYSTEM:'1',OPENSSL_CONF:'/dev/null',TMPDIR:tmp,CLAUDE_CODE_TMPDIR:tmp},profile};
}
