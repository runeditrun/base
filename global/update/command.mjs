// rer update [--version X]: move this rer to the registry's latest version (or
// X), the way it was installed. A user install (npx or install.sh) downloads,
// verifies and switches atomically through the new package's own
// `rer cli install`, keeping its channel; a failed or mismatched download
// leaves the current version selected. An npm global install runs npm for its
// own prefix and never writes a second launcher.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { dependencyEnvironment } from '../../onboarding/dependency-environment.mjs';
import { layout } from '../cli/layout.mjs';
import { channelOf } from '../cli/status.mjs';
import { ownManifest, ownRoot, packageDigest, packageName } from '../package-info.mjs';
import { readPackage, writePackage } from './archive.mjs';
import { compareVersions, packageMetadata, pickRelease, registryUrl, UpdateFailure } from './registry.mjs';

const usage = 'Usage: rer update [--version X]\n';

function parse(args) {
 if (!args.length) return {};
 if (args.length === 1 && args[0].startsWith('--version=') && args[0].length > 10) return { version: args[0].slice(10) };
 if (args.length === 2 && args[0] === '--version' && args[1] && !args[1].startsWith('-')) return { version: args[1] };
 return undefined;
}

const run = (program, args, env = process.env) => new Promise((resolve, reject) => {
 const child = spawn(program, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
 child.once('error', reject);
 child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});

// <prefix>/lib/node_modules/@runeditrun/rer, npm's global layout on macOS and Linux.
function npmPrefix() {
 const scope = dirname(ownRoot), modules = dirname(scope), lib = dirname(modules);
 if (basename(scope) !== '@runeditrun' || basename(modules) !== 'node_modules' || basename(lib) !== 'lib') throw new UpdateFailure(`This npm global rer is at ${ownRoot}, outside npm's usual layout; update it with npm install -g ${packageName}.`);
 return dirname(lib);
}

async function download(release) {
 const response = await fetch(release.dist.tarball).catch(error => { throw new UpdateFailure(`Could not download ${release.dist.tarball} (${error.cause?.code ?? error.message}).`); });
 if (!response.ok) throw new UpdateFailure(`${release.dist.tarball} answered ${response.status}.`);
 return readPackage(Buffer.from(await response.arrayBuffer()), release.dist);
}

async function npmGlobal(version) {
 const prefix = npmPrefix(), args = ['install', '-g', '--prefix', prefix, `${packageName}@${version}`];
 const command = `npm ${args.map(arg => /^[\w@./:=-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ')}`;
 process.stdout.write(`Updating the npm global rer: ${command}\n`);
 let code;
 try { code = await run('npm', args, dependencyEnvironment()); } catch (error) { code = 127; process.stderr.write(`Could not run npm (${error.code ?? error.message}).\n`); }
 if (code !== 0) {
  process.stderr.write(`npm could not update rer (exit ${code}); rer is unchanged. Fix the problem npm reports (for example, a prefix you cannot write), then run:\n  ${command}\n`);
  return code || 1;
 }
 const installed = JSON.parse(await readFile(join(prefix, 'lib/node_modules', packageName, 'package.json'), 'utf8')).version;
 process.stdout.write(`rer is now ${installed} (npm global, prefix ${prefix}).\n`);
 return 0;
}

export async function update(args) {
 if (args.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(`${usage}Move to the latest published rer (--version X for an exact one), the way it was installed:\nnpx and install.sh installs switch atomically, npm installs run npm.\n`); return 0; }
 const options = parse(args);
 if (!options) { process.stderr.write(`Unsupported: rer update ${args.join(' ')}\n${usage}`); return 2; }
 const { channel } = await channelOf(layout()), current = ownManifest().version;
 if (channel === 'source') { process.stderr.write(`This rer runs from a source checkout (${ownRoot}), which rer update does not change. Update the checkout with git, or install rer with: npx -y ${packageName} cli install\n`); return 1; }
 const work = await mkdtemp(join(tmpdir(), 'rer-update-'));
 try {
  const release = pickRelease(await packageMetadata(), options.version);
  if (!options.version && compareVersions(current, release.version) > 0) {
   process.stdout.write(`rer ${current} is newer than the latest published version (${release.version}); nothing changed. rer update --version ${release.version} installs that one.\n`);
   return 0;
  }
  // The same version counts as current only with the same contents: a
  // different build of that version is an update. (A development build's
  // version differs from its release's, so it always moves.)
  if (release.version === current || channel !== 'npm-global') {
   process.stdout.write(`Checking rer ${release.version} from ${registryUrl()}\n`);
   await writePackage(await download(release), join(work, 'package'));
   if (release.version === current && await packageDigest(join(work, 'package')) === await packageDigest(ownRoot)) {
    process.stdout.write(`rer ${current} is already current. Nothing changed.\n`);
    return 0;
   }
  }
  if (channel === 'npm-global') return await npmGlobal(release.version);
  return await run(process.execPath, [join(work, 'package/global/rer.mjs'), 'cli', 'install'], { ...process.env, RER_INSTALL_CHANNEL: channel, RER_INSTALL_NO_NEXT: '1' });
 } catch (error) {
  if (!(error instanceof UpdateFailure)) throw error;
  process.stderr.write(`rer update: ${error.message} rer ${current} is still selected.\n`);
  return 1;
 } finally { await rm(work, { recursive: true, force: true }); }
}
