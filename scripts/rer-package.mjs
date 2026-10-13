// Builds the @runeditrun/rer npm tarball from this Base checkout:
//   node scripts/rer-package.mjs --out DIR
// The last stdout line is the tarball's absolute path. The version comes from
// global/package.json; a commit that is not tagged rer-v<version> stamps
// <version>-dev.g<sha8>, which sorts below the release.
// The build is reproducible: the same commit gives the same bytes from any
// path on any day (see scripts/rer-package/tarball.mjs; every mtime is the
// commit time, SOURCE_DATE_EPOCH style).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from '../cli/export.mjs';
import { stampedVersion } from '../cli/version.mjs';
import { tarball } from './rer-package/tarball.mjs';

const manifestPath = 'global/package.json';
const installerPath = 'global/install.sh';

// npm consumes or renames these when it packs or installs a package (a
// .gitignore arrives as .npmignore), so a package carrying one would install
// different bytes through npx than through install.sh.
const npmControlFiles = new Set(['.gitignore', '.npmignore', '.npmrc']);

// The dispatcher's portable sources, its one onboarding copy at the package's
// own (Base) layout, and the global launcher. Test sources are excluded.
export async function packageFiles(base) {
 const files = [...await inventory(base), ...await inventory(base, ['onboarding']), ...await inventory(base, ['global'])];
 return [...new Set(files)].filter(path => path !== manifestPath && path !== installerPath && !npmControlFiles.has(path.split('/').pop())).sort();
}

export const packageVersion = (base, version) => stampedVersion(base, version);

const git = (base, args) => execFileSync('git', ['-C', base, ...args], { encoding: 'utf8' }).trim();

export async function buildPackage(base, out) {
 const template = JSON.parse(await readFile(join(base, manifestPath), 'utf8'));
 const version = packageVersion(base, template.version);
 const sourceDateEpoch = Number(git(base, ['log', '-1', '--format=%ct', 'HEAD']));
 // Published path -> source path in this checkout.
 const sources = new Map((await packageFiles(base)).map(path => [path, path]));
 sources.set('LICENSE', 'LICENSE').set('README.md', 'global/README.md').set('install.sh', installerPath);
 const entries = [];
 for (const [path, source] of sources) {
  const file = join(base, source);
  entries.push({ path: `package/${path}`, data: await readFile(file), executable: ((await stat(file)).mode & 0o100) !== 0 });
 }
 entries.push({ path: 'package/package.json', data: Buffer.from(JSON.stringify({ ...template, version }, null, 2) + '\n'), executable: false });
 await mkdir(out, { recursive: true });
 const target = resolve(out, `runeditrun-rer-${version}.tgz`);
 await writeFile(target, tarball(entries, sourceDateEpoch));
 return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const args = process.argv.slice(2);
 if (args.length !== 2 || args[0] !== '--out') { process.stderr.write('Usage: node scripts/rer-package.mjs --out DIR\n'); process.exit(2); }
 const tarball = await buildPackage(resolve(import.meta.dirname, '..'), resolve(args[1]));
 process.stdout.write(tarball + '\n');
}
