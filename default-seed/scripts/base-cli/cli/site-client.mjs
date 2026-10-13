import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { clientInputGuard } from './site-inputs.mjs';

// A separate browser build, using the seed's plugins. Only the graph reachable
// from its named entries ships; an external server import in that graph fails.
export async function writeSiteAsset(folder, name, data) {
 if (!name.startsWith('site-assets/') || name.split('/').includes('..')) throw Error('Compiled output must stay under site-assets/.');
 const file = join(folder,name), bytes = Buffer.from(data);
 await mkdir(dirname(file),{recursive:true});
 try { await writeFile(file,bytes,{flag:'wx'}); }
 catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (!bytes.equals(await readFile(file))) throw Error(`Conflicting compiled site asset ${name}.`);
 }
}

export async function buildClients(vite, root, folder, { entries = {}, config, privatePaths = [] } = {}) {
 if (!Object.keys(entries).length) return {clients:{},styles:[]};
 const guard = await clientInputGuard(root, privatePaths, async code => {
  await writeFile(`${folder}.refusal`, code);
  throw Error(code === 'site_private_input' ? 'Run site client imports a private or outside-seed file.' : 'Run site client imports a server-only module.');
 }, vite);
 const scratch = `${folder}.client`;
 try {
  const built = await vite.build({root, plugins:[guard], configFile:config ? resolve(root,config) : false, envFile:false, logLevel:'error', mode:'production',
   build:{ssr:false, lib:false, outDir:scratch, write:false, copyPublicDir:false, emptyOutDir:true, assetsDir:'site-assets', sourcemap:false, reportCompressedSize:false, watch:null,
    rollupOptions:{input:Object.fromEntries(Object.entries(entries).map(([name,path]) => [name,resolve(root,path)])), output:{entryFileNames:'site-assets/[name]-[hash].js',chunkFileNames:'site-assets/[name]-[hash].js'}}}});
  const output = (Array.isArray(built) ? built : [built]).flatMap(result => result.output ?? []);
  const chunks = new Map(output.filter(item => item.type === 'chunk').map(item => [item.fileName,item]));
  const clients = {}, shipped = new Set();
  const visit = file => {
   if (shipped.has(file)) return;
   const chunk = chunks.get(file);
   if (!chunk) throw Error(`Run site client imports ${file}, which is not bundled for the browser. Remove its server dependency or bundle it in the client config.`);
   shipped.add(file);
   for (const dependency of [...chunk.imports,...chunk.dynamicImports]) visit(dependency);
  };
  for (const name of Object.keys(entries)) {
   const entry = output.find(item => item.type === 'chunk' && item.isEntry && item.name === name);
   if (!entry) throw Error(`Run site client ${name} produced no entry chunk.`);
   clients[name] = '/' + entry.fileName; visit(entry.fileName);
  }
  for (const item of output) {
   if (item.type === 'chunk' && !shipped.has(item.fileName)) continue;
   await writeSiteAsset(folder,item.fileName,item.type === 'chunk' ? item.code : item.source);
  }
  return {clients,styles:output.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>'/' + item.fileName)};
 } finally { await rm(scratch,{recursive:true,force:true}); }
}
