import { inventorySchemaIdentity } from './catalogue.mjs';
import { canonicalJson } from './hash.mjs';
import { checkoutHistory } from './checkout-history.mjs';
import { migrationRecorder } from './migration-evidence.mjs';
import { insist, PortabilityError } from './storage.mjs';

async function appliedSnapshots(evidence,names,files) {
 const scratch=await evidence.openDatabase();
 try {
  const recorder=migrationRecorder(scratch),prefixes=[recorder.inventory()];
  for(const name of names) {
   recorder.apply(files.get(name));
   prefixes.push(recorder.inventory());
  }
  return {inventory:index=>prefixes[index],seeds:await recorder.seeds(prefixes.at(-1).objects)};
 }finally{scratch.close();}
}

function bundledSnapshots(evidence,names) {
 insist(evidence.prefixes.length===evidence.files.length+1
  && names.every((name,i)=>name===evidence.files[i]?.name),'schema_mismatch:legacy_evidence',409);
 return {
  inventory(index){
   const snapshot=evidence.prefixes[index];
   return {objects:snapshot.objects.map(i=>evidence.objects[i]),kinds:snapshot.shadows.map(name=>({name,type:'shadow'}))};
  },
  seeds:evidence.prefixes[names.length].seeds,
 };
}

// This adapter supplies replay evidence, never archive validation. The same
// collector, ledger matching, schema bridge and restore guards serve both doors.
export async function workerMigrations(db,input,evidence) {
 try {
  insist(evidence?.version===1 && !evidence.ownerSources?.length
   || evidence?.version===2 && evidence.ownerSources?.length && typeof evidence.openDatabase==='function','schema_mismatch:legacy_evidence',409);
  const {files,ownerSources}=evidence,fileByName=new Map(files.map(file=>[file.name,file]));
  return await checkoutHistory(db,input,files,async (names,config)=>{
   const {inventory,seeds}=evidence.version===2?await appliedSnapshots(evidence,names,fileByName):bundledSnapshots(evidence,names);
   return {names,statements:name=>fileByName.get(name)?.statements,sha256:name=>fileByName.get(name)?.sha256,
    schemaAfter(selected,options){
     insist(selected.length<=names.length && selected.every((name,i)=>name===names[i]),'schema_mismatch:legacy_evidence',409);
     return inventorySchemaIdentity(inventory(selected.length),config,options);
    },
    async rowImages(requests){return new Map(requests.filter(r=>seeds.some(s=>s.name===r.name && !s.hashes.length)).map(r=>[r.name,[]]));},
    async rowHashes(requests,limit){return new Map(requests.flatMap(r=>{const found=seeds.find(s=>s.name===r.name && s.hashes.length<=limit && canonicalJson(s.columns)===canonicalJson(r.columns));return found?[[r.name,found.hashes]]:[];}));},
   };
  },{nativeWrangler:true,ownerSources});
 }catch(error){if(error instanceof PortabilityError)throw error;throw new PortabilityError('schema_mismatch:legacy_evidence',409);}
}
