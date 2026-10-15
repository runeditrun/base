import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

// Select only regular files in canonical state, including SQLite sidecars.
// Do not follow links into other checkouts or pass directories to lsof.
export async function stateFiles(directory) {
 let entries;
 try{entries=await readdir(directory,{withFileTypes:true});}
 catch(error){if(error.code==='ENOENT')return [];throw error;}
 const files=[];
 for(const entry of entries){
  const path=join(directory,entry.name);
  if(entry.isDirectory())files.push(...await stateFiles(path));
  else if(entry.isFile())files.push(path);
 }
 return files;
}
