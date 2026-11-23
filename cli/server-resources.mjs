import {loadavg,tmpdir} from 'node:os';
import {statfs,lstat,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {refuse} from './errors.mjs';
import {serversDirectory} from './server-registry.mjs';
// Persistent serving is not a bounded queue job. Check its launch separately,
// after finite preparation, while its canonical server reservation is held.
// The 1-minute-load guard is a fleet's rule, set in the fleet's environment:
// without RER_SERVERS_LOAD_THRESHOLD a person's start is never refused for load.
// Estimate another dependency/runtime-state footprint plus room for growth.
// RER_SERVERS_DISK_FLOOR_GIB explicitly replaces the estimate (0 disables it).
export function servingLoadThreshold(env=process.env){
 if(env.RER_SERVERS_LOAD_THRESHOLD===undefined)return Infinity;
 const threshold=Number(env.RER_SERVERS_LOAD_THRESHOLD);
 if(!Number.isFinite(threshold)||threshold<0)throw refuse('Invalid server load threshold.');
 return threshold;
}
const gibibyte=1024n**3n;
export function serversDiskFloor(env=process.env,seedBytes=0n){
 const value=env.RER_SERVERS_DISK_FLOOR_GIB;
 if(value===undefined){
  const estimate=2n*seedBytes+gibibyte/4n,bytes=estimate>gibibyte?estimate:gibibyte;
  return {gib:Number(bytes)/Number(gibibyte),bytes};
 }
 const gib=Number(value);
 if(!/^(\d+\.?\d*|\.\d+)$/.test(value)||!Number.isFinite(gib))throw refuse('Invalid server disk floor. RER_SERVERS_DISK_FLOOR_GIB must be a number of GiB such as 4 or 2.5, 0 for no floor.');
 return {gib,bytes:BigInt(Math.round(gib*Number(gibibyte)))};
}
// Count logical file bytes conservatively, including pnpm's local .pnpm tree.
// Do not follow symlinks: linked packages are already in that tree, and links
// can point outside the seed or form cycles. Missing state has not been created.
async function seedDiskBytes(root){
 async function bytes(path){
  let info;try{info=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return 0n;throw error;}
  if(info.isSymbolicLink())return 0n;
  if(!info.isDirectory())return info.size;
  let total=0n;
  for(const name of await readdir(path))total+=await bytes(join(path,name));
  return total;
 }
 return await bytes(join(root,'node_modules'))+await bytes(join(root,'.wrangler'));
}
// The registry or TMPDIR may not exist yet. Its nearest existing ancestor is
// on the filesystem that will receive it; retain the requested path in errors.
async function diskAt(path,disk){
 try{return await disk(path,{bigint:true});}
 catch(error){if(error.code!=='ENOENT'||dirname(path)===path)throw error;return diskAt(dirname(path),disk);}
}
const loadWaitMinutes=10,loadWaitMs=loadWaitMinutes*60_000;
const loadProgressMs=20_000,loadPollMs=2000;
async function admitLoad(threshold,load,{signal,onLoadWaiting}){
 if(threshold===Infinity)return;
 const started=performance.now();
 let reportAt=started;
 for(;;){
  signal?.throwIfAborted();
  const measured=await load();
  signal?.throwIfAborted();
  if(Number.isFinite(measured)&&measured<=threshold)return;
  const current=performance.now(),elapsed=current-started,remaining=loadWaitMs-elapsed;
  const known=Number.isFinite(measured),sample=known?measured.toFixed(1):'unknown';
  if(!onLoadWaiting||remaining<=0){
   const waited=onLoadWaiting?` It waited ${loadWaitMinutes} minutes for the load to drop.`:'';
   const override=Math.ceil(Math.max(threshold,known?measured:0)*2);
   throw refuse(`Not started: this computer is busy. Its 1-minute load is ${sample} and a server starts only at ${threshold} or below.${waited}\nTry again in a few minutes, or start it anyway with a higher threshold, for example RER_SERVERS_LOAD_THRESHOLD=${override} ~/.local/bin/rer dev.`);
  }
  if(current>=reportAt){
   const elapsedSeconds=Math.floor(elapsed/1000);
   onLoadWaiting({
    phase:'server-load',
    message:`Waiting for the computer to calm down (${elapsedSeconds}s elapsed, up to ${loadWaitMinutes} minutes). Load ${sample} vs limit ${threshold}.`,
    elapsedSeconds,
    reasonCodes:[known?'load':'resources_unavailable'],
    resources:{load:known?measured:null},
    limits:{loadThreshold:threshold},
   });
   reportAt=current+loadProgressMs;
  }
  await delay(Math.min(loadPollMs,reportAt-current,remaining),undefined,{signal});
 }
}
export async function serverResources(root,{load=()=>loadavg()[0],disk=statfs,env=process.env,signal,onLoadWaiting}={}){
 const threshold=servingLoadThreshold(env);
 // Validate explicit values before doing any measurements.
 let floor=serversDiskFloor(env);
 await admitLoad(threshold,load,{signal,onLoadWaiting});
 if(env.RER_SERVERS_DISK_FLOOR_GIB===undefined)floor=serversDiskFloor(env,await seedDiskBytes(root));
 const temporary=resolve(env.TMPDIR||env.TMP||env.TEMP||tmpdir());
 for(const path of new Set([resolve(root),temporary,serversDirectory(env)])){
  const state=await diskAt(path,disk);
  const free=state.bavail*state.bsize;
  if(free<floor.bytes)throw refuse(`Server startup requires ${floor.bytes} bytes free (${floor.gib.toFixed(2)} GiB) at ${path}; it has ${free} bytes free (${(Number(free)/Number(gibibyte)).toFixed(2)} GiB). Recover owned space before retrying.\nRER_SERVERS_DISK_FLOOR_GIB explicitly overrides the seed-sized floor (GiB, decimals allowed, 0 for no floor).`);
 }
}
