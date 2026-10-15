import { readFile, writeFile, readdir, realpath, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseJsonc } from '../../cli/jsonc.mjs';
import { portabilityPlan } from './portability-schema.mjs';
import { checkBoundary } from './boundary.mjs';
import { localDurableObjects } from './durable-objects.mjs';
import { readMigrationRewrites, withRewrites } from '../deploy-kit/migrations.mjs';
const hash = source => createHash('sha256').update(source).digest('hex');
export async function buildContainer(root, options={}) {
 const previous=process.cwd();process.chdir(root);
 try{return await buildImage(root,options);}finally{process.chdir(previous);}
}
async function buildImage(root, { output = join(root,'.rer/container/image'), engine, cacheContract, runner, declaration } = {}) {
 const require = createRequire(join(root,'package.json'));
 declaration ??= JSON.parse(await readFile(join(root,'deploy.json'),'utf8'));
 engine ??= declaration.container?.engine ?? 'workerd'; cacheContract ??= declaration.container?.cacheContract; runner ??= declaration.container?.runner;
 if (!['workerd','node'].includes(engine)) throw new Error('Unsupported container engine');
 const vite = await import(pathToFileURL(require.resolve('vite'))), loaded = await vite.loadConfigFromFile({ command:'build',mode:'production' },undefined,root);
 if (!loaded) throw new Error('Vite configuration missing');
 // Config loading may prepare the seed's root Wrangler configuration. Inspect
 // its declared entry after that preparation, still before compiling the app.
 await checkBoundary(root,{engine,cacheContract});
 const config = loaded.config;
 const outputExports = new Map();
 const freshServerFiles = new Set(), serverOutput = resolve(root,'dist/server');
 if (engine === 'workerd') config.plugins = [...(config.plugins ?? []), {
  name:'rer-container-exports',
  async writeBundle(output,bundle) {
   const outputDir = resolve(root,output.dir ?? dirname(output.file));
   if (outputDir === serverOutput || outputDir.startsWith(serverOutput + sep)) {
    for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') {
     const path = resolve(outputDir,chunk.fileName);
     freshServerFiles.add(path);
     if (chunk.isEntry) outputExports.set(await realpath(path),new Set(chunk.exports));
    }
   }
  },
 }];
 if (engine === 'node') {
  const plugins = (await Promise.all(config.plugins.flat(Infinity))).filter(plugin => plugin && !plugin.name.startsWith('vite-plugin-cloudflare') && plugin.name !== 'tanstack-start-core:post-build');
  const bindingShim = resolve(import.meta.dirname,'bindings.mjs');
  config.plugins = [{ name:'rer-container-bindings', enforce:'pre',
   resolveId(id) { if (id === 'cloudflare:workers') return bindingShim; },
   transform(source,id) { if (cacheContract === 'lamp-retained-v1' && id === join(root,'src/server.ts')) return source.replace(/export\s*\{\s*SnapshotCache\s*\}\s*from\s*['"][^'"]+['"];?/,''); },
  },...plugins,{
   name:'rer-container-boundary-output',
   writeBundle(output,bundle) {
    const outputDir = resolve(root,output.dir ?? dirname(output.file));
    if (outputDir === serverOutput || outputDir.startsWith(serverOutput + sep)) for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') freshServerFiles.add(resolve(outputDir,chunk.fileName));
   },
  }];
  config.ssr = { ...config.ssr,noExternal:true }; config.environments = { ...config.environments,ssr:{ ...config.environments?.ssr,resolve:{ noExternal:true },build:{ ...config.environments?.ssr?.build,rolldownOptions:{ output:{ entryFileNames:'index.mjs' } } } } };
 }
 const builder = await vite.createBuilder({ ...config,root,configFile:false }); await builder.buildApp();
 // Apply the same local-only bundle guard before packaging any container image.
 await (await import('../../cli/dev-identity.mjs')).refuseDevLayerOutput(root);
 let workerConfig;
 if (engine === 'workerd') {
  workerConfig = JSON.parse(await readFile(join(root,'dist/server/wrangler.json'),'utf8'));
  localDurableObjects(workerConfig,outputExports.get(await realpath(resolve(root,'dist/server',workerConfig.main))));
 }
 else workerConfig = parseJsonc(await readFile(join(root,'wrangler.jsonc'),'utf8'));
 const serverEntry = engine === 'workerd' ? resolve(root,'dist/server',workerConfig.main) : resolve(root,'dist/server/index.mjs');
 if (!freshServerFiles.has(serverEntry)) throw new Error('Container server entry was not emitted by this build');
 await checkBoundary(root,{engine,cacheContract,entries:[serverEntry],emittedFiles:freshServerFiles,outputRoot:serverOutput});
 const { unstable_splitSqlQuery:split } = require('wrangler');
 const migrations = {}, rewrites = await readMigrationRewrites(root);
 for (const db of workerConfig.d1_databases ?? []) {
  let directory = resolve(root,db.migrations_dir ?? 'migrations');
  try { await readdir(directory); } catch { directory = resolve(root,'dist/server',db.migrations_dir); }
  migrations[db.binding] = [];
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) { const sql = await readFile(join(directory,name),'utf8'); migrations[db.binding].push({ name,sql,sha256:hash(sql),statements:split(sql) }); }
  migrations[db.binding] = withRewrites(migrations[db.binding], rewrites, { partial:true });
 }
 const entry = engine === 'workerd' ? 'dist/server/'+workerConfig.main : 'dist/server/index.mjs';
 await readFile(join(root,entry));
 if (engine === 'node' && workerConfig.kv_namespaces?.length) throw new Error('Node container does not support KV');
 for (const secret of declaration.secrets ?? []) if (Object.hasOwn(workerConfig.vars ?? {},secret.binding)) throw new Error('Secret declared as an image variable: '+secret.binding);
 const manifest = { version:1,engine,entry,cacheContract,runner,config:workerConfig,migrations,portabilityMigrations:await portabilityPlan(split),maxRequestBytes:25*1024*1024 };
 await rm(output,{recursive:true,force:true}); await mkdir(join(output,'app'),{recursive:true});
 await cp(join(root,'dist'),join(output,'app/dist'),{recursive:true}); await writeFile(join(output,'app/container.json'),JSON.stringify(manifest,null,2)+'\n');
 if (runner) {
  const within = path => { if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some(part => ['..','.',''].includes(part))) throw new Error('Invalid packaged runner path'); return join(root,path); };
  await readFile(within(runner.entry));
  for (const path of runner.files) await cp(within(path),join(output,'app/runner',path),{recursive:true,filter:path => !path.includes('/tests/') && !path.endsWith('/synthetic.mjs')});
 }
 const base = resolve(import.meta.dirname,'../..');
 for (const path of ['modules/container','modules/portability','modules/d1-transport','modules/deploy-kit','cli/scheduled.mjs','cli/jsonc.mjs','modules/integrations/core/public-address.ts']) { await mkdir(join(output,'runtime',path,'..'),{recursive:true}); await cp(join(base,path),join(output,'runtime',path),{recursive:true,filter:path => !path.includes('/tests/')}); }
 const dependencies = engine === 'workerd' ? { miniflare:'5.20260907.0-alpha' } : {};
 await writeFile(join(output,'runtime/package.json'),JSON.stringify({private:true,type:'module',dependencies}));
 await writeFile(join(output,'Dockerfile'),`FROM node:26.8.1-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates && apt-get clean\nRUN mkdir -p /private /archive\nWORKDIR /runtime\nCOPY runtime/package.json ./package.json\nRUN npm install --omit=dev --no-audit --no-fund\nCOPY runtime/ /runtime/\nCOPY app/ /app/\nENV NODE_ENV=production PORT=8080 WRANGLER_SEND_METRICS=false\nEXPOSE 8080\nVOLUME /data\nENTRYPOINT ["sh", "/runtime/modules/container/entrypoint.sh"]\n`);
 return { output,manifest };
}
if (process.argv[1] === import.meta.filename) { try { const {output,engine,declaration}=JSON.parse(process.argv[3]??'{}'),result=await buildContainer(resolve(process.argv[2]),{...(output?{output:resolve(output)}:{}),...(engine?{engine}:{}),...(declaration?{declaration}:{})}); console.log(JSON.stringify({output:result.output,engine:result.manifest.engine})); } catch(cause) { console.error(cause.message); if(cause.failures)console.error(JSON.stringify(cause.failures));process.exitCode=1; } }
