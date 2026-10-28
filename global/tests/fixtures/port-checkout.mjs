// A real CLI dispatcher and local installer with a minimal test application.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = resolve(import.meta.dirname, '../../..');
const source = path => JSON.stringify(pathToFileURL(join(base, path)).href);

export async function portCheckout(root, directory) {
 await mkdir(join(root, 'scripts'), { recursive: true });
 await mkdir(join(root, 'node_modules'));
 await writeFile(join(root, 'node_modules/.modules.yaml'), '');
 const pins = JSON.parse(await readFile(join(base, 'default-seed/package.json'), 'utf8'));
 await writeFile(join(root, '.node-version'), pins.engines.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: pins.engines, packageManager: pins.packageManager }));
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'synthetic-base-1', groups: [], steps: [{ type: 'extension', id: 'native-owner' }],
  fields: [{ name: 'OWNER_EMAIL', label: 'Owner email', kind: 'email', required: true }] }));
 await writeFile(join(root, 'app.mjs'), `
import { createServer } from 'node:http';
createServer((request, response) => response.end(JSON.stringify({ status: 'ok' }))).listen(Number(process.argv[2]), '127.0.0.1');
`);
 await writeFile(join(root, 'adapter.mjs'), `
import { localInstaller } from ${source('onboarding/adapter.mjs')};
import { commandAdapter as declare } from ${source('cli/adapter.mjs')};
const lifecycle = localInstaller({ secrets: { file: '.dev.vars', format: 'dotenv', originKey: 'AUTH_ORIGIN', values: ({ origin }) => ({ AUTH_ORIGIN: origin }) },
 start: context => ['node', [${JSON.stringify(join(root, 'app.mjs'))}, String(context.runtimePort ?? new URL(context.origin).port)]],
 signIn: async () => {} });
export const commandAdapter = declare(lifecycle, { setup: { manifestFile: 'rer-setup.json' }, input: { names: { email: 'OWNER_EMAIL' } }, settings: ['.dev.vars'] });
`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'synthetic-base-1', runtime: { requirements: [] }, requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(['setup', 'dev', 'doctor'].map(verb => [verb, { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Local port flow.' }])) }));
 // The first setup finds its chosen port already taken by another program.
 await writeFile(join(root, 'scripts/rer.mjs'), `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
const args = process.argv.slice(2), holderFile = ${JSON.stringify(join(directory, 'holder.pid'))};
if (args[0] === 'setup' && args.includes('--port') && !existsSync(holderFile)) {
 const port = args[args.indexOf('--port') + 1];
 const holder = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(" + port + ", '127.0.0.1', () => console.log('up'))"], { cwd: ${JSON.stringify(directory)}, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
 writeFileSync(holderFile, String(holder.pid), { flag: 'wx' });
 writeFileSync(${JSON.stringify(join(directory, 'taken-port'))}, port);
 await once(holder.stdout, 'data');
 holder.stdout.destroy(); holder.unref();
}
const { main } = await import(${source('cli/main.mjs')});
process.exitCode = await main();
`);
}
