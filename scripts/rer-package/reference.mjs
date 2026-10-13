// The default-seed reference in package mode, from one built tarball: a local
// registry serves that tarball, and the reference is exported and converted
// with the export tool's --to-package (to the latest version that registry
// holds), exactly as a seed is. The returned env sends @runeditrun to the
// registry, so pnpm installs in the converted checkout get the same bytes.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPackage } from '../../global/update/archive.mjs';
import { exportReference } from '../export-reference.mjs';
import { integrity, localRegistry } from './registry.mjs';

function run(program, args, options) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.once('error', reject);
  child.once('close', code => resolveRun({ code, stdout, stderr }));
 });
}

export async function packageReference(base, root, tarball, { directory, env }) {
 const bytes = await readFile(tarball);
 const { version } = JSON.parse(readPackage(bytes, { integrity: integrity(bytes) }).find(file => file.path === 'package.json').data);
 const registry = await localRegistry();
 try {
  registry.publish(version, bytes);
  const npmrc = join(directory, 'rer-scope.npmrc');
  await writeFile(npmrc, registry.npmrc());
  const scoped = { ...env, NPM_CONFIG_USERCONFIG: npmrc };
  await exportReference(base, root);
  const converted = await run(process.execPath, [join(base, 'scripts/export-cli.mjs'), '--to-package', root], { cwd: base, env: scoped });
  if (converted.code !== 0) throw new Error(`The export tool did not convert the reference (exit ${converted.code}):\n${converted.stdout}${converted.stderr}`);
  return { registry, env: scoped, version, transcript: converted.stdout };
 } catch (error) { await registry.close(); throw error; }
}
