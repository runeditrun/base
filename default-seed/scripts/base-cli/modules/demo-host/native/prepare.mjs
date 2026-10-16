import { readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { collectBuildModules } from '../../deploy-kit/build-modules.mjs';
import { collectFiles } from '../../deploy-kit/artifact.mjs';
import { nativeBindings, ISOLATE_FILES } from './config.mjs';

// Reuse the normal production build and its migration inventory, without
// building or running a container. The bundle is stored once in the front.
export async function prepareNative(folder) {
  const app = join(folder, 'image/app');
  const manifest = JSON.parse(await readFile(join(app, 'container.json'), 'utf8'));
  const config = manifest.config, root = join(app, 'dist/server');
  const bindings = nativeBindings(config);
  const main = relative(root, resolve(root, config.main));
  const modules = {};
  for (const file of await collectBuildModules(root, config, main)) {
    const source = Buffer.from(file.base64, 'base64');
    if (/\.(m?js)$/.test(file.path)) modules[`app/${file.path}`] = { js: source.toString('utf8') };
    else if (/\.(txt|html|sql)$/.test(file.path)) modules[`app/${file.path}`] = { text: source.toString('utf8') };
    else throw new Error(`Loader demo does not implement module type: ${file.path}`);
  }
  const entry = `../app/${main}`;
  modules['_rer/isolate.js'] = { js: (await readFile(new URL('./isolate.mjs', import.meta.url), 'utf8')).replace('__RER_APP_ENTRY__', entry)
    + [...new Set(bindings.objects.map(item => item.class_name))].map(name => `\nexport { ${name} } from ${JSON.stringify(entry)};`).join('') };
  for (const file of ISOLATE_FILES) modules[`_rer/${file}.js`] = { js: await readFile(new URL(`./${file}.mjs`, import.meta.url), 'utf8') };
  const assets = await collectFiles(join(app, 'dist/client'));
  const bundle = { compatibilityDate: config.compatibility_date, compatibilityFlags: [...new Set([...(config.compatibility_flags ?? []), 'nodejs_compat'])], modules,
    bindings, migrations: manifest.migrations, vars: config.vars ?? {}, crons: config.triggers?.crons ?? [],
    assetPaths: assets.filter(file => !file.path.split('/').some(part => part.startsWith('.'))).map(file => '/' + file.path) };
  bundle.digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  await cp(join(app, 'dist/client'), join(folder, 'assets'), { recursive: true });
  await writeFile(join(folder, 'modules/demo-host/native/bundle.mjs'), `export default ${JSON.stringify(bundle)};\n`);
  return bundle;
}
