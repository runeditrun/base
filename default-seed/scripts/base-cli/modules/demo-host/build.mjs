import { readFile, writeFile, realpath, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { containerMigrationInventory as demoMigrationInventory } from '../container/migration-inventory.mjs';
import { checkImageVariables as checkBuildVariables } from '../container/image-variables.mjs';
import { localDurableObjects } from '../container/durable-objects.mjs';
import { readMigrationRewrites, withRewrites } from '../deploy-kit/migrations.mjs';

// The seed's ordinary production Worker output, with the declared SQL inventory.
// No image, runtime emulator or dependency installation belongs in this bundle.
export async function buildDemo(root, output, declaration) {
  const require = createRequire(join(root, 'package.json'));
  const vite = await import(pathToFileURL(require.resolve('vite')));
  const loaded = await vite.loadConfigFromFile({ command: 'build', mode: 'production' }, undefined, root);
  if (!loaded) throw new Error('Vite configuration missing');
  const emitted = new Map();
  const config = { ...loaded.config, root, configFile: false, plugins: [...(loaded.config.plugins ?? []), {
    name: 'rer-demo-output',
    async writeBundle(output, bundle) {
      const directory = resolve(root, output.dir ?? dirname(output.file));
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') emitted.set(await realpath(join(directory, chunk.fileName)), new Set(chunk.exports));
    },
  }] };
  await (await vite.createBuilder(config)).buildApp();
  await (await import('../../cli/dev-identity.mjs')).refuseDevLayerOutput(root);
  const workerConfig = JSON.parse(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'));
  if (!emitted.has(await realpath(resolve(root, 'dist/server', workerConfig.main)))) throw new Error('Demo Worker entry was not emitted by this build');
  localDurableObjects(workerConfig, emitted.get(await realpath(resolve(root, 'dist/server', workerConfig.main))));
  await checkBuildVariables(root, workerConfig.vars ?? {}, declaration.secrets ?? []);
  const { unstable_splitSqlQuery: split } = require('wrangler');
  const migrations = Object.fromEntries((workerConfig.d1_databases ?? []).map(db => [db.binding, []]));
  const inventory = withRewrites(await demoMigrationInventory(root, { config: workerConfig, configFile: 'dist/server/wrangler.json' }), await readMigrationRewrites(root));
  for (const { binding, ...migration } of inventory) migrations[binding].push({ ...migration, statements: split(migration.sql) });
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'app'), { recursive: true });
  await cp(join(root, 'dist'), join(output, 'app/dist'), { recursive: true });
  await writeFile(join(output, 'app/demo.json'), JSON.stringify({ config: workerConfig, migrations }) + '\n');
}

if (process.argv[1] === import.meta.filename) {
  try { await buildDemo(resolve(process.argv[2]), resolve(process.argv[3]), JSON.parse(process.argv[4])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
