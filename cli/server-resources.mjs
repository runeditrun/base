import {loadavg,tmpdir} from 'node:os';
import {statfs} from 'node:fs/promises';
import {refuse} from './errors.mjs';
// Persistent serving is not a bounded queue job. Check its launch separately,
// after finite preparation, while its canonical server reservation is held.
// The 1-minute-load guard is a fleet's rule, set in the fleet's environment:
// without RER_SERVERS_LOAD_THRESHOLD a person's start is never refused for load.
// The free-disk floor is 15 GiB; a CI or managed build runner on a smaller disk
// sets RER_SERVERS_DISK_FLOOR_GIB, in GiB with decimals allowed and 0 for no floor.
export function servingLoadThreshold(env=process.env){
 if(env.RER_SERVERS_LOAD_THRESHOLD===undefined)return Infinity;
 const threshold=Number(env.RER_SERVERS_LOAD_THRESHOLD);
 if(!Number.isFinite(threshold)||threshold<0)throw refuse('Invalid server load threshold.');
 return threshold;
}
const gibibyte=1024n**3n;
export function serversDiskFloor(env=process.env){
 const value=env.RER_SERVERS_DISK_FLOOR_GIB;
 if(value===undefined)return {gib:15,bytes:15n*gibibyte};
 const gib=Number(value);
 if(!/^(\d+\.?\d*|\.\d+)$/.test(value)||!Number.isFinite(gib))throw refuse('Invalid server disk floor. RER_SERVERS_DISK_FLOOR_GIB must be a number of GiB such as 4 or 2.5, 0 for no floor.');
 return {gib,bytes:BigInt(Math.round(gib*Number(gibibyte)))};
}
export async function serverResources(root,{load=()=>loadavg()[0],disk=statfs,env=process.env}={}){
 const threshold=servingLoadThreshold(env),floor=serversDiskFloor(env);
 const measured=threshold===Infinity?0:await load();
 if(!Number.isFinite(measured)||measured>threshold)throw refuse(`Not started: this computer is busy. Its 1-minute load is ${Number.isFinite(measured)?measured.toFixed(1):'unknown'} and a server starts only at ${threshold} or below.\nTry again in a few minutes, or start it anyway with a higher threshold, for example RER_SERVERS_LOAD_THRESHOLD=${Math.ceil(Math.max(threshold,Number.isFinite(measured)?measured:0)*2)} rer dev.`);
 for(const path of new Set([root,tmpdir()])){
  const state=await disk(path,{bigint:true});
  const free=state.bavail*state.bsize;
  if(free<floor.bytes)throw refuse(`Server startup requires ${floor.gib} GiB free on checkout and temporary volumes, and ${path} has ${(Number(free*10n/gibibyte)/10).toFixed(1)} GiB free. Recover owned space before retrying.\nA CI runner on a small disk can lower the floor with RER_SERVERS_DISK_FLOOR_GIB (for example 4).`);
 }
}
