import {readdir,open} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
// D1 intentionally denies integrity_check through its SQL API. Inspect the
// actual persisted SQLite files read-only, including WAL, without an adapter.
export async function storageCheck(root='/data'){
 const files=[];
 async function visit(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);
   if(entry.isDirectory()){await visit(path);continue}
   if(!entry.isFile())continue;
   const file=await open(path,'r'),header=Buffer.alloc(16);
   try{await file.read(header,0,16,0)}finally{await file.close()}
   if(header.toString()!=='SQLite format 3\u0000')continue;
   const db=new DatabaseSync(path,{readOnly:true});
   try{files.push({file:relative(root,path),integrity:db.prepare('PRAGMA integrity_check').all().map(row=>Object.values(row)[0]),foreign_key_violations:db.prepare('PRAGMA foreign_key_check').all().length})}finally{db.close()}
  }
 }
 await visit(root);if(!files.length)throw Error('No persisted SQLite database found');
 return {files,all_ok:files.every(file=>file.integrity.every(value=>value==='ok')&&file.foreign_key_violations===0)};
}
