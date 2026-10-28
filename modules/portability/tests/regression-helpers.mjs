import { Miniflare,convertV4MiniflareOptions } from '../../container/adapters/d1-workerd.mjs';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortability,readArchive,canonicalJson } from '../index.mjs';
const schema=await readFile(new URL('../schema/portability.sql',import.meta.url),'utf8');
export async function database(t,ddl,policy) {
  const directory=await mkdtemp(join(tmpdir(),'portability-regression-'));
  const mf=new Miniflare({...convertV4MiniflareOptions({cf:false,modules:true,
    script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-01',
    d1Databases:{DB:'regression'},r2Buckets:{FILES:'regression'}}),resourcePersistencePath:directory});
  t.after(async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});});
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('FILES');
  await db.batch([...schema.split(';').map(s=>s.trim()).filter(Boolean),...ddl].map(sql=>db.prepare(sql)));
  const service=await createPortability({db,buckets:{FILES:bucket},policy});
  return {db,bucket,service};
}
export async function bundle(service) {
  const id=await service.exports.create();
  while((await service.exports.advance(id,{maxParts:100})).phase==='building'){}
  const records=[];for await(const record of readArchive(await service.exports.download(id)))records.push(record);
  return {id,manifest:records[0],parts:records.filter(r=>r.kind==='part'),closing:records.at(-1),records};
}
export async function stage(service,archive) {
  const id=await service.imports.create(archive.manifest);
  for(const part of archive.parts)await service.imports.uploadPart(id,part.index,part);
  return id;
}
export const rows=archive=>archive.parts.flatMap(p=>p.items).filter(i=>i.kind==='row');
export const stream=records=>new Response(records.map(canonicalJson).join('\n')+'\n').body;
