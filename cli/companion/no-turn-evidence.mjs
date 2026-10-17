import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function canonical(path) {
  if(typeof path!=='string'||!path.startsWith('/')) throw new Error('Provider evidence cannot be attributed to a workspace.');
  try { return await realpath(path); } catch(error) { if(error.code==='ENOENT')return resolve(path);throw error; }
}
async function inspectSessions(directory, worktree) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error('Provider session evidence must not be a symlink.');
    if(entry.isDirectory()){await inspectSessions(path,worktree);continue;}
    if(!entry.isFile())throw new Error('Unknown provider session evidence.');
    const file=await open(path,'r'),buffer=Buffer.alloc(65536);
    let header;
    try {const {bytesRead}=await file.read(buffer,0,buffer.length,0);header=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8').split('\n')[0]);}
    finally {await file.close();}
    if(header.type!=='session_meta')throw new Error('Provider session evidence cannot be attributed to a workspace.');
    if(await canonical(header.payload?.cwd)===worktree)throw new Error('Recorded provider sessions prevent no-turn attestation.');
  }
}

// Recorded work for another mapped checkout is unrelated. Unknown evidence fails
// closed; absence of an in-memory identity never overrides provider history.
export async function assertNoTurnEvidence(root, state) {
  if (state.provider && state.provider !== 'codex') throw new Error('No-turn attestation supports only the inspected Codex state format.');
  if (state.outbox?.length) throw new Error('Pending relay events must be reconciled before no-turn attestation.');
  const worktree=await canonical(state.active?.workspace?.worktree);
  const home = join(root, 'executor-home', '.codex');
  let entries;
  try { entries = await readdir(home); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const directory of ['sessions','archived_sessions']) {
    if (!entries.includes(directory)) continue;
    const path=join(home,directory),info=await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Recorded provider sessions prevent no-turn attestation.');
    await inspectSessions(path,worktree);
  }
  for (const name of entries.filter(name => /^state(?:_.*)?\.sqlite$/.test(name))) {
    const path=join(home,name),info=await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Provider state must be a regular database.');
    const database=new DatabaseSync(path,{readOnly:true});
    try {
      for(const row of database.prepare('SELECT cwd FROM threads').all()) {
        if(await canonical(row.cwd)===worktree) throw new Error('Recorded provider threads prevent no-turn attestation.');
      }
    } finally { database.close(); }
  }
}
