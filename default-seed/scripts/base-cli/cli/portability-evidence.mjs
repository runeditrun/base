import { DatabaseSync } from 'node:sqlite';
import { realpath, readFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { migrationDirectory } from './portability-migrations.mjs';
import { splitStatements } from '../modules/portability/sql-text.mjs';
import { canonicalJson, sha256 } from '../modules/portability/hash.mjs';
import { quote, insist } from '../modules/portability/storage.mjs';
import { dataStatement, triggerBodies } from '../modules/portability/migration-statements.mjs';
import { sqliteTokens } from '../modules/portability/sqlite-tokens.mjs';

// Date functions can default to 'now'; even fixed arguments are conservatively
// excluded from seeded-row evidence. Their schema and statements remain intact.
const variable=sql=>/\b(?:random|randomblob|date|time|datetime|julianday|strftime|unixepoch|sqlite_version|sqlite_source_id)\s*\(|\bcurrent_(?:date|time|timestamp)\b/i.test(sqliteTokens(sql).map(t=>t.value).join(' '));

// Only migration-owned schema and hashed seeded-row identities enter the bundle.
// Never open a live database, settings file, archive, or archive-supplied path.
export async function generateMigrationEvidence(root,{binding='DB'}={}) {
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
 const objects=[],indices=new Map(),prefixes=[];
 const scratch=new DatabaseSync(':memory:');
 try {
  // Volatile defaults, trigger bodies and reads propagate to their writers.
  // Such rows cannot equal a fresh library replay reliably either. Preserve
  // deterministic seeds in unrelated tables, and empty evidence everywhere.
  const unstable=new Set(),applied=[];
  const capture=async()=>{
   const schema=scratch.prepare("SELECT name,sql,type,tbl_name FROM sqlite_master WHERE sql IS NOT NULL AND substr(lower(name),1,7)<>'sqlite_' AND substr(lower(name),1,4)<>'_cf_' ORDER BY name,type").all();
   const refs=schema.map(object=>{
    const key=canonicalJson(object);if(!indices.has(key)){indices.set(key,objects.length);objects.push(object);}return indices.get(key);
   });
   const shadows=scratch.prepare('PRAGMA table_list').all().filter(t=>t.type==='shadow').map(t=>t.name).sort();
   const seeds=[];
   for(const {name} of schema.filter(o=>o.type==='table')) {
    const columns=scratch.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c=>c.name);
    const rows=scratch.prepare(`SELECT json_array(${columns.map(c=>`quote(${quote(c)})`).join(',')}) image FROM ${quote(name)} LIMIT 10001`).all().map(r=>r.image);
    if(rows.length>10000 || unstable.has(name.toLowerCase()) && rows.length)continue;
    seeds.push({name,columns,hashes:(await Promise.all(rows.map(sha256))).sort()});
   }
   prefixes.push({objects:refs,shadows,seeds});
  };
  await capture();
  for(const file of files) {
   for(const sql of file.statements) {
    const data=dataStatement(sql);
    if(data) {
     const writers=new Set([data.target]);
     for(const name of writers)for(const target of triggerBodies(applied,name))writers.add(target);
     const definitions=scratch.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL").all();
     if(variable(sql) || data.names.some(n=>unstable.has(n)) || definitions.some(d=>writers.has(d.name.toLowerCase()) && variable(d.sql))
       || applied.some(s=>variable(s) && [...writers].some(n=>triggerBodies([s],data.target).includes(n))))for(const name of writers)unstable.add(name);
    }
    scratch.exec(sql);
    applied.push(sql);
   }
   await capture();
  }
 }finally{scratch.close();}
 return {version:1,files,objects,prefixes};
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
   return 'export default '+canonicalJson(await generateMigrationEvidence(root,{binding}))+';';
  },
 };
}
