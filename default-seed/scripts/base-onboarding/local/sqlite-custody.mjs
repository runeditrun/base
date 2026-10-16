import {open} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {stateFiles} from './state-files.mjs';

// A launch lock excludes cooperating commands. When process inspection fails,
// SQLite can still positively identify a conflicting transaction without a
// process-table walk. This cannot detect idle file handles or WAL readers.
export async function sqliteCustody(root) {
 for(const path of await stateFiles(join(root,'.wrangler/state'))){
  // Sidecars are not databases; state can disappear after this snapshot.
  if(/-(?:wal|shm|journal)$/.test(path))continue;
  let file;
  try{file=await open(path,'r');}catch(error){if(error.code==='ENOENT')continue;throw error;}
  let sqlite;
  try{
   const header=Buffer.alloc(16),{bytesRead}=await file.read(header,0,16,0);
   sqlite=bytesRead===16&&header.toString()==='SQLite format 3\0';
  }finally{await file.close();}
  if(!sqlite)continue;
  // Lazy import keeps the database engine out of early launcher registration.
  const {DatabaseSync}=await import('node:sqlite');
  let db;
  try{
   // This must be a writable connection: read-only WAL transactions do not
   // exclude writers. Closing it may checkpoint idle WAL, so never use it for
   // demo, whose canonical owner-state bytes must remain unchanged.
   db=new DatabaseSync(path);
   db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK;');
  }catch(error){
   if(error.errcode===5||error.errcode===6)return relative(root,path);
   throw new Error('Could not check the local SQLite lock. Preserve local state and resolve the database error before retrying.');
  }finally{db?.close();}
 }
}
