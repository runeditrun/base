import {readdir,lstat,realpath} from 'node:fs/promises';
import {basename,join} from 'node:path';

// Importing the owner-name helper must not load the database engine or emit
// its runtime warning before the launcher registers its worker.
async function openDatabase(path,options){
 const {DatabaseSync}=await import('node:sqlite');
 return new DatabaseSync(path,options);
}

// The owner the zero-setup `rer dev` gives a checkout before its real owner is known.
export function zeroSetupOwner(checkout){
 const label=basename(checkout).toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,63)||'checkout';
 return `owner@${label}.test`;
}
async function databases(root){
 let directory=root;
 for(const part of ['.wrangler','state','v3','d1','miniflare-D1DatabaseObject']){
  directory=join(directory,part);let status;try{status=await lstat(directory);}catch(error){if(error.code==='ENOENT')return []; throw error;}
  if(status.isSymbolicLink()||!status.isDirectory())throw Error('Canonical local state is unsafe. Preserve it and recover its placement before setup.');
 }
 return (await readdir(directory,{withFileTypes:true})).filter(file=>file.isFile()&&file.name.endsWith('.sqlite')).map(file=>join(directory,file.name));
}
// Read only the canonical local D1 files, before settings/build/migrations can
// mutate anything. An unrelated database does not establish an owner claim.
export async function localOwners(root){
 const found=[];
 for(const path of await databases(root)){
  let db,owners=[];
  try{db=await openDatabase(path,{readOnly:true});
   const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
   if(tables.has('oa_operators'))owners=db.prepare("SELECT email FROM oa_operators WHERE role='owner' AND status='active'").all();
  }finally{db?.close();}
  found.push(...owners.map(owner=>owner.email).filter(email=>typeof email==='string'));
 }
 return [...new Set(found)];
}
// Returns the existing owners, and `placeholder` when the canonical database's
// only owner is still this checkout's zero-setup owner: setup replaces it.
export async function assertLocalOwner(root,email,failure=message=>Error(message),inspect,setting='private owner email setting'){
 const owners=inspect?await inspect(root):await localOwners(root);
 if(!Array.isArray(owners)||owners.some(owner=>typeof owner!=='string'))throw failure('The localOwner hook must return existing owner email addresses without changing state.');
 const placeholder=!inspect&&owners.length===1&&owners[0].toLowerCase()===zeroSetupOwner(await realpath(root))?owners[0]:undefined;
 if(placeholder)return {owners,placeholder};
 if(owners.length&&!owners.some(owner=>owner.toLowerCase()===email.toLowerCase())){
  const address=safeOwner(owners[0]);
  throw failure(`Local database already belongs to ${address}. Restore ${setting} to ${address}, then run rer setup --owner-email ${address}; or back up data, run rer dev --stop, then rer reset --yes followed by rer setup --owner-email ${safeOwner(email)}. Reset deletes local data. Existing data and private settings were kept.`);
 }
 return {owners};
}
// The placeholder owner's own row takes the real owner's address, so every
// record that names the owner by id stays theirs. Its version moves on, which
// retires sign-in links issued to the placeholder.
export async function replaceLocalOwner(root,from,to,failure=message=>Error(message)){
 for(const path of await databases(root)){
  const db=await openDatabase(path);
  try{
   const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
   if(!tables.has('oa_operators'))continue;
   if(db.prepare('SELECT 1 FROM oa_operators WHERE lower(email)=lower(?) AND lower(email)<>lower(?)').get(to,from))throw failure(`${safeOwner(to)} already has an account in the local database, so the zero-setup owner ${safeOwner(from)} was kept. Run rer setup --owner-email ${safeOwner(from)}, or back up data and run rer reset --yes.`);
   db.prepare("UPDATE oa_operators SET email=?,version=version+1 WHERE lower(email)=lower(?) AND role='owner' AND status='active'").run(to,from);
  }finally{db.close();}
 }
}
export const safeOwner=email=>email.length<=254&&/^[a-zA-Z0-9.!+_%\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)+$/.test(email)?email:'<existing-owner-email>';
