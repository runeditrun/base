import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
export async function loadState(root) {
  await mkdir(root,{recursive:true,mode:0o700});
  try {return JSON.parse(await readFile(join(root,'state.json'),'utf8'));} catch(error) {if(error.code==='ENOENT') return {mappings:{},outbox:[],cursor:0};throw error;}
}
export async function saveState(root,state) {
  await writeFile(join(root,'state.tmp'),JSON.stringify(state,null,2),{mode:0o600});
  await rename(join(root,'state.tmp'),join(root,'state.json'));
}
