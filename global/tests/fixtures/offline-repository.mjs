// A real rer package and its real private-settings lifecycle. No application
// hooks: this fixture tests repository install/setup, not application readiness.
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pins } from '../../../cli/contract.mjs';

export async function offlineRepository(source, tarball, runPnpm) {
 await copyFile(tarball, join(source, 'rer.tgz'));
 await writeFile(join(source, 'package.json'), JSON.stringify({
  name: 'offline-repository', private: true, type: 'module',
  engines: { node: pins.node }, packageManager: `pnpm@${pins.pnpm}`,
  devDependencies: { '@runeditrun/rer': 'file:rer.tgz' },
 }));
 await writeFile(join(source, '.node-version'), pins.node + '\n');
 await writeFile(join(source, '.gitignore'), 'node_modules\n.dev.vars\n.seed\n.rer\n.wrangler\n');
 // Frozen installs use only the committed tarball, including in a cold HOME.
 await writeFile(join(source, '.npmrc'), 'offline=true\nupdate-notifier=false\nregistry=http://127.0.0.1:9\n');
 await writeFile(join(source, 'adapter.mjs'), `
import { localInstaller } from '@runeditrun/rer/local-installer';
import { commandAdapter as declare } from '@runeditrun/rer/adapter';
const lifecycle = localInstaller({
 secrets: { file: '.dev.vars', originKey: 'AUTH_ORIGIN', keepExisting: true,
  values: context => ({ OWNER_EMAIL: context.input.OWNER_EMAIL, AUTH_ORIGIN: context.origin }) },
});
export const commandAdapter = declare(lifecycle, {
 setup: { manifestFile: 'rer-setup.json' }, input: { names: { email: 'OWNER_EMAIL' } },
});
`);
 await writeFile(join(source, 'rer-setup.json'), JSON.stringify({
  schema: 1, title: 'Local settings', groups: [],
  fields: [{ name: 'OWNER_EMAIL', label: 'Owner email', kind: 'email', required: true }],
  steps: [{ type: 'extension', id: 'private-settings' }],
 }));
 await writeFile(join(source, 'OPERATIONS.json'), JSON.stringify({
  version: 2, project: 'example/offline-repository', runtime: { requirements: [] }, requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' },
  commands: Object.fromEntries(['install', 'setup'].map(verb => [verb, {
   argv: ['rer', verb], inputs: ['adapter.mjs'], effects: 'Install dependencies and prepare private local settings.',
  }])),
 }));
 await runPnpm(['install', '--lockfile-only', '--offline']);
}
