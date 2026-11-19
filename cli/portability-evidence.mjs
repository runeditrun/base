import { DatabaseSync } from 'node:sqlite';
import { realpath, readFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationDirectory } from './portability-migrations.mjs';
import { ownerMigrationSources } from './portability-owners.mjs';
import { collectMigrations } from '../modules/delivery-producer/migrations.mjs';
import { splitStatements } from '../modules/portability/sql-text.mjs';
import { canonicalJson, sha256 } from '../modules/portability/hash.mjs';
import { insist } from '../modules/portability/storage.mjs';
import { migrationRecorder } from '../modules/portability/migration-evidence.mjs';

const wasmPath = fileURLToPath(new URL('./vendor/wa-sqlite/wa-sqlite.wasm', import.meta.url));
const sqlitePath = fileURLToPath(new URL('./portability-sqlite.mjs', import.meta.url));

// Only migration-owned schema and hashed seeded-row identities enter the bundle.
// Never open a live database, settings file, archive, or archive-supplied path.
async function migrationEvidence(root,{binding='DB'}={}) {
 root=await realpath(root);
 const directory=await realpath(await migrationDirectory(root,binding));
 const path=relative(root,directory);
 insist(!isAbsolute(path) && path!=='..' && !path.startsWith('..'+sep),'schema_mismatch:legacy_evidence',409);
 const files=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>{
  const file=await realpath(resolve(directory,name)),path=relative(directory,file);
  insist(!isAbsolute(path) && path!=='..' && !path.startsWith('..'+sep),'schema_mismatch:legacy_evidence',409);
  const bytes=await readFile(file);
  return {name,sha256:await sha256(bytes),statements:splitStatements(bytes.toString('utf8'))};
 }));
 const sources=await ownerMigrationSources(root,binding);
 if (sources.length) {
  const declared = new Set(files.map(file => file.name));
  const ownerFiles = await Promise.all(sources.filter(source => source.directory).map(async ({directory,prefix,table}) => {
   const owners = await collectMigrations(root, [{binding,path:directory,prefix}], [{kind:'d1',binding}]);
   return owners.map(({name,sha256,sql}) => ({name,sha256,statements:splitStatements(sql),table}));
  }));
  for (const file of ownerFiles.flat()) {
   insist(!declared.has(file.name),'migration_ledger:ambiguous',409);
   declared.add(file.name);
   files.push(file);
  }
  return {version:2,files,ownerSources:sources.map(({prefix,table})=>({prefix,table}))};
 }
 return bundledPrefixes(files);
}

async function bundledPrefixes(files) {
 const objects=[],indices=new Map(),prefixes=[];
 const scratch=new DatabaseSync(':memory:');
 try {
  const recorder=migrationRecorder({exec:sql=>scratch.exec(sql),all:sql=>scratch.prepare(sql).all()});
  const capture=async()=>{
   const {objects:schema,kinds}=recorder.inventory();
   const refs=schema.map(object=>{
    const key=canonicalJson(object);if(!indices.has(key)){indices.set(key,objects.length);objects.push(object);}return indices.get(key);
   });
   prefixes.push({objects:refs,shadows:kinds.map(kind=>kind.name).sort(),seeds:await recorder.seeds(schema)});
  };
  await capture();
  for(const file of files) {
   recorder.apply(file);
   await capture();
  }
 }finally{scratch.close();}
 return {version:1,files,objects,prefixes};
}

export async function generateMigrationEvidence(root,options) {
 const evidence = await migrationEvidence(root,options);
 if (evidence.version === 1) return evidence;
 const {sqliteMemory} = await import('./portability-sqlite.mjs');
 return {...evidence,openDatabase:sqliteMemory(await WebAssembly.compile(await readFile(wasmPath)))};
}

// Explicit seed opt-in. The module is consumed only by the server/Worker graph;
// it is bundled and hashed by the existing Vite and deploy package paths.
export function legacyMigrationEvidence({binding='DB'}={}) {
 const id='virtual:rer-legacy-migration-evidence',internal='\0'+id;
 let root;
 return {
  name:'rer:legacy-migration-evidence',
  configResolved(config){root=config.root;},
  resolveId(source){if(source===id)return internal;},
  async load(source){
   if(source!==internal)return;
   if(this.environment?.name==='client')throw new Error('Legacy migration evidence is server-only.');
   const evidence = await migrationEvidence(root,{binding});
   if (evidence.version === 1) return 'export default '+canonicalJson(evidence)+';';
   return `import wasm from ${JSON.stringify(wasmPath)};
import { sqliteMemory } from ${JSON.stringify(sqlitePath)};
export default { ...${canonicalJson(evidence)}, openDatabase: sqliteMemory(wasm) };`;
  },
 };
}
