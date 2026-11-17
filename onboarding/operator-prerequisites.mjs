import { readdir,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const failure=(field,found,expected)=>({field,found,expected});
// Read-only: preflight never creates a database or owner. Report the furthest
// proven prerequisite in one database, without reading any credential values.
export async function operatorPrerequisites(root){
 const migrations=(await readdir(join(root,'migrations/core'))).filter(name=>name.endsWith('.sql')).sort();
 const directory=join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
 const absent=failure('local database','unset','set');
 let files;try{
  let path=root;for(const part of ['.wrangler','state','v3','d1','miniflare-D1DatabaseObject']){path=join(path,part);const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid())return absent;}
  files=await readdir(directory,{withFileTypes:true});}catch{return absent;}
 let result=absent,progress=0;
 for(const file of files){
  if(!file.isFile()||!file.name.endsWith('.sqlite'))continue;
  let db,stage=1,problem=failure('d1_migrations','unset','set');
  try{
   db=new DatabaseSync(join(directory,file.name),{readOnly:true});
   const applied=new Set(db.prepare('SELECT name FROM d1_migrations').all().map(row=>row.name));
   stage=2;
   const pending=migrations.find(name=>!applied.has(name));
   problem=pending?failure(`migration ${pending}`,'unapplied','applied'):failure('oa_bootstrap','unset','one durable owner claim');
   if(!pending){
    stage=3;
    const claimed=db.prepare('SELECT COUNT(*) AS count FROM oa_bootstrap').get().count;
    problem=failure('oa_bootstrap',String(claimed),'1');
    if(claimed===1){
     stage=4;problem=failure('oa_operators active owner','unset','at least one');
     const owners=db.prepare("SELECT COUNT(*) AS count FROM oa_operators WHERE role='owner' AND status='active'").get().count;
     if(owners>0)return true;
     problem=failure('oa_operators active owner',String(owners),'at least one');
    }
   }
  }catch{/* A missing/corrupt/unrelated database proves only prior stages. */}
  finally{db?.close();}
  if(stage>progress){progress=stage;result=problem;}
 }
 return result;
}
