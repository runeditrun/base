import { shared } from '../../../cli/shared.mjs';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { collectBuildModules } from '../../deploy-kit/build-modules.mjs';
import { collectFiles, moduleType } from '../../deploy-kit/artifact.mjs';
import { nativeBindings, ISOLATE_FILES, objectExports } from './config.mjs';
import { warmList, builtChunks } from './warm.mjs';
import { prepareTheme } from '../theme.mjs';

// The Worker Loader module kind for each upload type deploy-kit gives a build
// module, so a demo carries what a normal deploy uploads. Binary kinds travel
// as base64 in the bundle; loader.mjs hands the Loader their bytes.
const LOADER_KINDS = { 'application/javascript+module': 'js', 'text/plain': 'text', 'application/wasm': 'wasm', 'application/octet-stream': 'data' };
export function loaderModule(path, bytes) {
  const type = moduleType(path), kind = LOADER_KINDS[type];
  if (!kind) throw new Error(`Loader demo cannot load ${type ?? 'unknown'} module type: ${path}`);
  return { [kind]: ['js', 'text'].includes(kind) ? bytes.toString('utf8') : bytes.toString('base64') };
}

// Reuse the normal production build and its migration inventory, without
// building or running a container. The bundle is stored once in the front.
export async function prepareNative(folder) {
  const app = join(folder, 'bundle/app');
  const manifest = JSON.parse(await readFile(join(app, 'demo.json'), 'utf8'));
  const config = manifest.config, root = join(app, 'dist/server');
  const bindings = nativeBindings(config);
  const main = relative(root, resolve(root, config.main));
  const modules = {};
  for (const file of await collectBuildModules(root, config, main)) modules[`app/${file.path}`] = loaderModule(file.path, Buffer.from(file.base64, 'base64'));
  const entry = `../app/${main}`;
  modules['_rer/isolate.js'] = { js: (await readFile(new URL('./isolate.mjs', import.meta.url), 'utf8')).replace('__RER_APP_ENTRY__', entry)
    + objectExports(bindings) };
  for (const file of ISOLATE_FILES) modules[`_rer/${file}.js`] = { js: await readFile(new URL(`./${file}.mjs`, import.meta.url), 'utf8') };
  const assets = await collectFiles(join(app, 'dist/client'));
  await cp(join(app, 'dist/client'), join(folder, 'assets'), { recursive: true });
  const theme = await prepareTheme(folder, assets);
  const { readIconFiles } = await shared('icon-files.mjs');
  const { links: iconHead } = await readIconFiles(join(app, 'dist/client'));
  const bundle = { iconHead, compatibilityDate: config.compatibility_date, compatibilityFlags: [...new Set([...(config.compatibility_flags ?? []), 'nodejs_compat'])], modules,
    bindings, migrations: manifest.migrations, vars: config.vars ?? {}, crons: config.triggers?.crons ?? [],
    assetPaths: [...assets.filter(file => !file.path.split('/').some(part => part.startsWith('.'))).map(file => '/' + file.path), ...theme.paths],
    theme: theme.css,
    immutable: [...builtChunks(assets, manifest.assetsDir)].sort(),
    warm: (await warmList(assets, root, manifest.operatorPath, manifest.assetsDir)).paths };
  bundle.digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  await writeFile(join(folder, 'modules/demo-host/native/bundle.mjs'), `export default ${JSON.stringify(bundle)};\n`);
  return bundle;
}
