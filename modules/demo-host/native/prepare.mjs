import { readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { collectBuildModules } from '../../deploy-kit/build-modules.mjs';
import { collectFiles } from '../../deploy-kit/artifact.mjs';

// Reuse the normal production build and its migration inventory, without
// building or running a container. The bundle is stored once in the front.
export async function prepareNative(folder) {
  const app = join(folder, 'image/app');
  const manifest = JSON.parse(await readFile(join(app, 'container.json'), 'utf8'));
  const config = manifest.config, root = join(app, 'dist/server');
  if (config.d1_databases?.length !== 1) throw new Error('Loader demo currently requires exactly one D1 binding');
  if ((config.triggers?.crons ?? []).some(cron => cron !== '* * * * *')) throw new Error('Loader demo currently supports only once-per-minute cron');
  for (const key of ['r2_buckets', 'kv_namespaces', 'durable_objects', 'queues', 'services', 'workflows']) {
    const value = config[key];
    if (Array.isArray(value) ? value.length : value && Object.values(value).some(items => Array.isArray(items) && items.length)) throw new Error(`Loader demo does not implement ${key} bindings`);
  }
  const main = relative(root, resolve(root, config.main));
  const modules = {};
  for (const file of await collectBuildModules(root, config, main)) {
    const source = Buffer.from(file.base64, 'base64');
    if (/\.(m?js)$/.test(file.path)) modules[`app/${file.path}`] = { js: source.toString('utf8') };
    else if (/\.(txt|html|sql)$/.test(file.path)) modules[`app/${file.path}`] = { text: source.toString('utf8') };
    else throw new Error(`Loader demo does not implement module type: ${file.path}`);
  }
  modules['_rer/isolate.js'] = { js: (await readFile(new URL('./isolate.mjs', import.meta.url), 'utf8')).replace('__RER_APP_ENTRY__', `../app/${main}`) };
  modules['_rer/d1.js'] = { js: await readFile(new URL('./d1.mjs', import.meta.url), 'utf8') };
  modules['_rer/sql.js'] = { js: await readFile(new URL('./sql.mjs', import.meta.url), 'utf8') };
  const assets = await collectFiles(join(app, 'dist/client'));
  const database = config.d1_databases[0].binding;
  const bundle = { compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags ?? [], modules,
    database, migrations: manifest.migrations[database], vars: config.vars ?? {}, crons: config.triggers?.crons ?? [],
    assetPaths: assets.filter(file => !file.path.split('/').some(part => part.startsWith('.'))).map(file => '/' + file.path) };
  bundle.digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  await cp(join(app, 'dist/client'), join(folder, 'assets'), { recursive: true });
  await writeFile(join(folder, 'modules/demo-host/native/bundle.mjs'), `export default ${JSON.stringify(bundle)};\n`);
  return bundle;
}
