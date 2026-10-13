import { readArchive,canonicalJson } from '../index.mjs';
export { runtime,build,fixtureSQL } from './runtime.mjs';
export async function seed(f) {
  await f.db.batch([
    'PRAGMA defer_foreign_keys=ON',"INSERT INTO self_ref VALUES('child','parent'),('parent','parent')",
    "INSERT INTO cycle_a VALUES('a','b')","INSERT INTO cycle_b VALUES('b','a')",
    "INSERT INTO compound VALUES('key',2,'second'),('key',1,'first')","INSERT INTO heap VALUES('twice'),('twice'),('last')",
    "INSERT INTO blobs VALUES(1,x'0001ff80')","INSERT INTO effects VALUES('send',1,'queued','synthetic-sensitive-value')",
    "INSERT INTO settings VALUES('theme','blue')","INSERT INTO triggered VALUES('original')",
    "INSERT INTO files VALUES('small'),('large')","INSERT INTO private_notes VALUES('excluded')","INSERT INTO oa_sessions VALUES('excluded-session')",
  ].map(s=>f.db.prepare(s)));
  await f.bucket.put('small',new Uint8Array([1,2,3]),{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{label:'small'}});
  await f.bucket.put('large',new Uint8Array(18000).map((_,i)=>i%251),{httpMetadata:{contentType:'image/png',cacheControl:'private'},customMetadata:{label:'large',purpose:'fixture'}});
}
export async function archive(service,{interrupt}={}) {
  const id=await service.exports.create();let status=await service.exports.status(id);
  while(status.phase==='building'){status=await service.exports.advance(id,{maxParts:10});if(interrupt)service=await interrupt(id,status);}
  const records=[];for await(const record of readArchive(await service.exports.download(id)))records.push(record);
  return {id,records,manifest:records[0],parts:records.filter(r=>r.kind==='part'),closing:records.at(-1),contentHash:records.at(-1).contentHash};
}
export async function restore(service,bundle,{interrupt,options}={}) {
  const id=await service.imports.create(bundle.manifest);
  for(const part of bundle.parts){await service.imports.uploadPart(id,part.index,part);if(interrupt)service=await interrupt(id,part);}
  return {id,status:await service.imports.finalize(id,{contentHash:bundle.contentHash,archiveHash:bundle.closing.archiveHash,...options})};
}
export function bytesStream(value){return new Response(typeof value==='string'?value:canonicalJson(value)).body;}
export const bundleStream=records=>bytesStream(records.map(canonicalJson).join('\n')+'\n');
export async function collect(generator){const out=[];for await(const v of generator)out.push(v);return out;}
export function rows(bundle){return bundle.parts.flatMap(p=>p.items).filter(x=>x.kind==='row');}
