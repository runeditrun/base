import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { door } from './door/fixture.ts';
import { createImportDoorHandler } from '../src/door/index.ts';
import { retireD1ImportCustody } from '../src/d1/index.ts';
import type { ImportDoorPackageSource, ImportDoorPackageUpload, DoorGrant } from '../src/door/index.ts';
import type { ParsedRecord } from '../src/types.ts';
import { sha256 } from '../src/provenance/identity.ts';
import { buildPackage, transferPackage } from '../../../cli/business/package-transfer.mjs';
import { legacyPackage } from '../../../cli/fixtures/business/legacy-package.mjs';
import { cli, connect, legacyTask } from '../../../cli/fixtures/business/legacy-cli.mjs';
import { server } from '../../../cli/fixtures/business/server.mjs';
import { verifyLegacyPackage } from '../../../cli/business/legacy-package.mjs';
const QUOTA = 2 * 1024 ** 2;
const grants = {maxBytes:QUOTA,maxChunks:32,maxRecords:100_000};
async function temporary(t:any) { const root = await mkdtemp(join(tmpdir(),'.business-connect-package-')); t.after(()=>rm(root,{recursive:true,force:true})); return root; }
async function upload(d:any, bytes:Buffer, name:string, extra:Partial<DoorGrant>={}) {
 let uploadId:string|undefined;
 for(let index=0;index<Math.ceil(bytes.length/65_536);index++) {
  const chunk=bytes.subarray(index*65_536,(index+1)*65_536), result=await d.call('uploads',{...(uploadId?{uploadId}:{}),name,bundleSha256:sha256(bytes),totalBytes:bytes.length,totalChunks:Math.ceil(bytes.length/65_536),index,chunkSha256:sha256(chunk),base64:chunk.toString('base64')},{...grants,...extra});
  assert.equal(result.status,200,JSON.stringify(result.body));uploadId=result.body.uploadId;
 }
 return uploadId!;
}
function declaration(read:ImportDoorPackageSource['read'],formats=['test-package/1']):ImportDoorPackageSource {return {formats,maxBytes:16*1024**2,maxSegments:16,read};}
const rows:ParsedRecord[]=[{kind:'document',sourceId:'1',payload:{title:'First'}},{kind:'document',sourceId:'2',payload:{title:'Second'}}];
async function prepared(t:any,total:number|null=2,records=rows,quota=QUOTA) {
 const root=await temporary(t), file=join(root,'records.json'), bytes=Buffer.from(JSON.stringify(records));await writeFile(file,bytes);
 return buildPackage({files:[{path:'records.json',file,bytes:bytes.length,sha256:sha256(bytes)}],source:{format:'test-package/1',version:1,origin:'synthetic-database',exportedAt:null,synthetic:true,adapter:'test'},records:{total,byKind:total===null?{}:{document:2}},totals:{},quota,directory:join(root,'prepared')});
}

test('P2 package probe has no plan; missing, foreign and altered segments have the same scoped refusal; one aggregate plan is idempotent',async t=>{
 const d=await door(t);await d.enable();
 d.mount(createImportDoorHandler({...d.options,package:declaration(async pkg=>JSON.parse(Buffer.from(await pkg.read('records.json')).toString()))}));
 const pkg=await prepared(t), manifest=Buffer.from(await readFile(pkg.manifestFile.file)), uploadId=await upload(d,manifest,'rer-package.json');
 const missing=()=>d.call('plan',{uploadId},grants), plans=()=>d.runtime.native().prepare('SELECT count(*) n FROM ik_door_plans').get()!.n;
 const first=await missing();assert.deepEqual([first.status,first.body.error],[409,'package_segment_missing']);assert.deepEqual(first.body.details.missing,pkg.manifest.segments);assert.equal(plans(),0);
 const segmentId=await upload(d,Buffer.from(await readFile(pkg.segments[0].file)),'rer-segment');
 const db=d.runtime.native();
 db.prepare("UPDATE ik_door_uploads SET installation_id='foreign' WHERE id=?").run(segmentId);assert.equal((await missing()).body.error,'package_segment_missing');
 db.prepare("UPDATE ik_door_uploads SET installation_id='test-installation',namespace='foreign' WHERE id=?").run(segmentId);assert.equal((await missing()).body.error,'package_segment_missing');
 db.prepare("UPDATE ik_door_uploads SET namespace='knowledge',total_bytes=total_bytes+1 WHERE id=?").run(segmentId);assert.equal((await missing()).body.error,'package_segment_missing');
 db.prepare('UPDATE ik_door_uploads SET total_bytes=total_bytes-1 WHERE id=?').run(segmentId);
 const original=db.prepare('SELECT base64 FROM ik_door_chunks WHERE upload_id=? AND ordinal=0').get(segmentId)!.base64;
 db.prepare("UPDATE ik_door_chunks SET base64='YWx0ZXJlZA==' WHERE upload_id=? AND ordinal=0").run(segmentId);assert.equal((await missing()).body.error,'package_segment_missing');assert.equal(plans(),0);
 db.prepare('UPDATE ik_door_chunks SET base64=? WHERE upload_id=? AND ordinal=0').run(original,segmentId);
 const accepted=await missing();assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.summary.sourceRecords,2);assert.equal(accepted.body.created,true);
 assert.equal((await missing()).body.planId,accepted.body.planId);assert.equal(plans(),1);assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,0);
 t.diagnostic('PROBE P2 installation/namespace/hash/size custody, manifest-before-segments 409/no plan, aggregate plan once; native writes=0');
 // The same real HTTP/SQLite path must withdraw resolved package custody on
 // refusal, just as it withdraws an incumbent upload. Collect every retention
 // failure so the before/after run exercises all three refusal paths.
 const retained:string[]=[];
 for(const mode of ['erased','credential','invalid'] as const) {
  const e=await door(t);await e.enable();const native=e.runtime.native(),marker=['package',mode,'private'].join('-');
  const records=[{kind:'document',sourceId:'person',payload:{id:'person',title:marker,body:marker+'x'.repeat(70_000)+marker}},rows[1]];
  if(mode==='credential') Object.assign(records[0].payload,{url:`https://user:${marker}@example.test/`});
  if(mode==='invalid') Object.assign(records[0].payload,{note:'%'+'25'.repeat(33)+'41'});
  e.mount(createImportDoorHandler({...e.options,package:declaration(async p=>JSON.parse(Buffer.from(await p.read('records.json')).toString()))}));
  const preparedPackage=await prepared(t,2,records,65_536), small={...grants,maxBytes:65_536,maxChunks:1};
  assert.equal(preparedPackage.segments.length,2);
  const send=async()=>{
   const manifestId=await upload(e,Buffer.from(await readFile(preparedPackage.manifestFile.file)),'rer-package.json',small),ids:string[]=[];
   for(const segment of preparedPackage.segments) ids.push(await upload(e,Buffer.from(await readFile(segment.file)),'rer-segment',small));
   return {manifestId,ids};
  };
  const holders=()=>native.prepare("SELECT c.base64 FROM ik_door_chunks c JOIN ik_door_uploads u ON u.id=c.upload_id WHERE u.installation_id='test-installation' AND u.namespace='knowledge'").all()
   .filter(row=>Buffer.from(row.base64 as string,'base64').toString().includes(marker)).length;
  if(mode==='erased') {
   // Preserve erasure of a package that was already applied, including segments.
   const before=await send(),planned=await e.call('plan',{uploadId:before.manifestId},small);assert.equal(planned.status,200,JSON.stringify(planned.body));
   assert.equal((await e.apply(planned.body)).state,'completed');assert.equal(holders(),2);
   const erased=await retireD1ImportCustody({target:{kind:'record',id:'person'}},[{sql:"DELETE FROM native_records WHERE id='person'"}],e.runtime.context(),[{sql:'UPDATE native_authority SET enabled=enabled'}]);
   assert.equal(erased.phase,'complete');assert.equal(holders(),0);
   const incumbent=await e.upload([records[0].payload]),refused=await e.call('plan',{uploadId:incumbent});
   assert.deepEqual([refused.status,refused.body.error],[409,'source_erased']);assert.equal(holders(),0);
   assert.equal((await e.call('uploads',{uploadId:incumbent})).status,404);
   t.diagnostic('PROBE cleanup applied-package erasure holders=0; later incumbent refusal=409 source_erased holders=0');
  }
  const sent=await send();
  // Equivalent uploads in this scope must not leave another retained copy.
  await upload(e,Buffer.from(await readFile(preparedPackage.segments[0].file)),'rer-segment',small);
  // Neither a foreign installation nor a foreign namespace is cleanup authority.
  const foreign:string[]=[];
  for(const field of ['installation_id','namespace']) {
   const id=await upload(e,Buffer.from(await readFile(preparedPackage.segments[0].file)),'rer-segment',small);
   native.prepare(`UPDATE ik_door_uploads SET ${field}='foreign' WHERE id=?`).run(id);foreign.push(id);
  }
  const foreignChunks=()=>foreign.map(id=>native.prepare('SELECT * FROM ik_door_chunks WHERE upload_id=?').all(id));
  const unchanged=foreignChunks();
  // A second manifest can legitimately resolve the same uploads. Cleanup must
  // make its inventory request the missing bytes, rather than use stale custody.
  const shared=await upload(e,Buffer.from(JSON.stringify({...preparedPackage.manifest,mode:'shared'})),'rer-package.json',small);
  const expected=mode==='erased'?[409,'source_erased']:[422,mode==='credential'?'source_credential':'source_invalid_or_credential_source_data'];
  const refused=await e.call('plan',{uploadId:sent.manifestId},small);
  assert.deepEqual([refused.status,refused.body.error],expected,JSON.stringify(refused.body));
  assert.equal((await e.call('uploads',{uploadId:sent.manifestId},small)).status,404);
  assert.deepEqual(foreignChunks(),unchanged);
  const remaining=holders();if(remaining) retained.push(`${mode}: ${remaining} decoded chunk holders`);
  // Inspect every scoped custody table as well as the decoded upload chunks.
  const tables=native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='ik_door_chunks'").all().map(row=>row.name as string);
  for(const table of tables) for(const row of native.prepare(`SELECT * FROM ${table}`).all()) assert.ok(!JSON.stringify(row).includes(marker),table);
  const sharedPlan=await e.call('plan',{uploadId:shared},small);
  if(sharedPlan.body.error!=='package_segment_missing') retained.push(`${mode}: shared manifest did not request missing segments`);
  else assert.deepEqual(sharedPlan.body.details.missing,preparedPackage.manifest.segments);
  t.diagnostic(`PROBE cleanup ${mode} refusal=${refused.status} ${refused.body.error} decoded_holders=${remaining} foreign_scopes_unchanged=true shared=${sharedPlan.body.error}`);
  if(mode==='erased') {
   // A failed segment withdrawal must also roll back the manifest deletion.
   const atomic=await send(), held=holders();
   native.exec(`CREATE TRIGGER refuse_segment_cleanup BEFORE DELETE ON ik_door_chunks WHEN OLD.upload_id='${atomic.ids[0]}' BEGIN SELECT RAISE(ABORT,'test cleanup failure'); END`);
   const interrupted=await e.call('plan',{uploadId:atomic.manifestId},small);assert.ok([409,410].includes(interrupted.status),JSON.stringify(interrupted.body));
   const inventory=await e.call('uploads',{uploadId:atomic.manifestId},small);
   if(inventory.status!==200 || holders()!==held) retained.push('erased: segment cleanup did not roll back the manifest and chunks together');
   native.exec('DROP TRIGGER refuse_segment_cleanup');
   t.diagnostic(`PROBE cleanup rollback manifest_status=${inventory.status} decoded_holders=${holders()} expected=${held}`);
   if(inventory.status===200) {
    const retried=await e.call('plan',{uploadId:atomic.manifestId},small);assert.deepEqual([retried.status,retried.body.error],expected);
    assert.equal(holders(),0);
   }
  }
 }
 assert.deepEqual(retained,[],'refused packages keep no scoped sensitive segment copies');
});

test('P2 actual aggregate count is limited even for legacy null total, before mapping or plan writes; undeclared sources remain unchanged',async t=>{
 const d=await door(t);await d.enable();let maps=0;
 const pkg=await prepared(t,null), uploadId=await upload(d,Buffer.from(await readFile(pkg.manifestFile.file)),'rer-package.json');
 await upload(d,Buffer.from(await readFile(pkg.segments[0].file)),'rer-segment');
 d.mount(createImportDoorHandler({...d.options,mapping:{version:'v1',map:record=>{maps++;return {effects:[{targetKind:'record',targetId:record.sourceId,value:record.payload}]};}},package:declaration(async p=>JSON.parse(Buffer.from(await p.read('records.json')).toString()))}));
 const limited=await d.call('plan',{uploadId},{...grants,maxRecords:1});assert.deepEqual([limited.status,limited.body.error],[403,'plan_exceeds_grant_quota']);assert.equal(maps,0);
 assert.equal(d.runtime.native().prepare('SELECT count(*) n FROM ik_door_plans').get()!.n,0);
 d.mount(createImportDoorHandler(d.options));assert.equal((await d.call('plan',{uploadId},grants)).body.error,'seed_package_unsupported');
 const {parse,mapping,...mount}=d.options;
 d.mount(createImportDoorHandler({...mount,source:namespace=>namespace==='knowledge'?{parse,mapping}:null}));
 const before=d.runtime.native().prepare('SELECT count(*) n FROM ik_door_grants').get()!.n;
 assert.equal((await d.call('plan',{uploadId},{...grants,namespace:'unlisted'})).body.error,'unknown_import_source');assert.equal(d.runtime.native().prepare('SELECT count(*) n FROM ik_door_grants').get()!.n,before);
});

test('bounded accessor verifies index/file hashes and file limits; returned metadata cannot alter custody',async t=>{
 const d=await door(t);await d.enable();const pkg=await prepared(t), uploadId=await upload(d,Buffer.from(await readFile(pkg.manifestFile.file)),'rer-package.json');
 await upload(d,Buffer.from(await readFile(pkg.segments[0].file)),'rer-segment');
 d.mount(createImportDoorHandler({...d.options,package:declaration(async p=>{
  await assert.rejects(p.read('../escape'),/package_file_missing/);await assert.rejects(p.read('records.json',1),/package_file_exceeds_limit/);
  // The callback sees a detached manifest; mutating it cannot move byte ranges.
  (p.manifest.index as {bytes:number}).bytes=0;
  return JSON.parse(Buffer.from(await p.read('records.json')).toString());
 })}));
 assert.equal((await d.call('plan',{uploadId},grants)).status,200);
});


test('P5 a 404 inventory restarts only the forgotten segment; file digest failures refuse planning',async t=>{
 const d=await door(t);await d.enable();const pkg=await prepared(t);
 d.mount(createImportDoorHandler({...d.options,package:declaration(async p=>JSON.parse(Buffer.from(await p.read('records.json')).toString()))}));
 let interrupt=true, forgotten:string|undefined, inventory404=0;
 const request=async (grant:{action:string},body:any)=>{
  const result=await d.call(grant.action as any,body,grants);
  if(result.status!==200) {if(result.status===404)inventory404++;throw Object.assign(Error(result.body.error),{doorStatus:result.status,doorCode:result.body.error,doorDetails:result.body.details});}
  if(interrupt && body.name==='rer-segment') {forgotten=body.uploadId;throw Error('interrupted after durable chunk');}
  return result.body;
 };
 const options={prepared:pkg,fresh:async(action:string)=>({action}),request,signal:new AbortController().signal,checkpoint:async()=>{}};
 await assert.rejects(transferPackage(options),/interrupted after durable chunk/);assert.ok(forgotten);
 d.runtime.native().prepare('DELETE FROM ik_door_chunks WHERE upload_id=?').run(forgotten);
 d.runtime.native().prepare('DELETE FROM ik_door_uploads WHERE id=?').run(forgotten);
 interrupt=false;const transferred=await transferPackage(options);assert.equal(inventory404,1);
 assert.equal((await d.call('plan',{uploadId:transferred.uploadId},grants)).status,200);
 // A file digest in an otherwise self-consistent transport cannot substitute for its bytes.
 const corrupt=await prepared(t), bytes=Buffer.from(await readFile(corrupt.segments[0].file));
 const index=JSON.parse(bytes.subarray(0,corrupt.manifest.index.bytes).toString());index.sha256='0'.repeat(64);
 const changedIndex=Buffer.from(JSON.stringify(index)+'\n');assert.equal(changedIndex.length,corrupt.manifest.index.bytes);changedIndex.copy(bytes);
 corrupt.manifest.index.sha256=sha256(changedIndex);corrupt.manifest.stream.sha256=sha256(bytes);corrupt.manifest.segments[0].sha256=sha256(bytes);
 const another=await door(t);await another.enable();another.mount(createImportDoorHandler({...another.options,package:declaration(async p=>JSON.parse(Buffer.from(await p.read('records.json')).toString()))}));
 const manifestId=await upload(another,Buffer.from(JSON.stringify(corrupt.manifest)),'rer-package.json');await upload(another,bytes,'rer-segment');
 assert.equal((await another.call('plan',{uploadId:manifestId},grants)).body.error,'package_file_hash_mismatch');
 assert.equal(another.runtime.native().prepare('SELECT count(*) n FROM ik_door_plans').get()!.n,0);
});

test('P1/P3/P5 public rer business run --once transfers >5 MiB with a >2 MiB object, resumes only missing chunks after SIGKILL, and plans once',async t=>{
 const home=await temporary(t), source=await legacyPackage(join(home,'legacy'),{large:true}), verified=await verifyLegacyPackage(source.root), d=await door(t);await d.enable();
 let readBack=0;
 const reader=declaration(async (pkg:ImportDoorPackageUpload)=>{
  readBack++;
  const files=new Map<string,Buffer>();
  // Re-derive every file digest and byte size from bytes actually transferred.
  for(const file of pkg.files) {const bytes=Buffer.from(await pkg.read(file.path,8*1024**2));assert.equal(bytes.length,file.bytes);assert.equal(sha256(bytes),file.sha256);assert.deepEqual(bytes,source.files.get(file.path));files.set(file.path,bytes);}
  const manifest=JSON.parse(files.get('manifest.json')!.toString()), rowCounts:Record<string,number>={}, records:ParsedRecord[]=[];
  for(const part of manifest.chunks) {const rows=JSON.parse(files.get(part.file)!.toString());assert.equal(rows.length,part.count);rowCounts[part.table]=(rowCounts[part.table]??0)+rows.length;for(const row of rows)records.push({kind:part.table,sourceId:String(row.id),payload:row});}
  const objectBytes=manifest.objects.reduce((n:number,o:any)=>{const bytes=files.get(o.file)!;assert.equal(bytes.length,o.size);assert.equal(sha256(bytes),o.sha256);return n+bytes.length;},0);
  assert.deepEqual(rowCounts,manifest.source.rowCounts);assert.equal(manifest.objects.length,manifest.source.attachments.length);assert.deepEqual(pkg.manifest.totals,{rowCounts,objects:{count:manifest.objects.length,bytes:objectBytes}});
  assert.equal(pkg.manifest.records.total,null);assert.equal(pkg.manifest.source.origin,'legacy-database');
  assert.equal(d.runtime.native().prepare('SELECT count(*) n FROM native_records').get()!.n,0);
  return records;
 },['happytohelp-legacy-chunks-v1']);
 const real=createImportDoorHandler({...d.options,package:reader}), planRows:any[]=[], uploads:any[]=[];let child:any, killed=false;
 d.mount(async request=>{
  const action=new URL(request.url).pathname.split('/').pop(), body=await request.clone().json() as any;
  if(action==='uploads') {
   uploads.push(body);
   // Commit the chunk first, then kill before the acknowledgement reaches rer.
   if(!killed && body.name==='rer-segment' && body.index===7) {const response=await real(request);killed=true;child.kill('SIGKILL');return response;}
  }
  const response=await real(request);
  if(action==='plan' && response?.status===200) {const preview=await response.clone().json() as any;if(!planRows.some(p=>p.planId===preview.planId))planRows.push({...preview,uploadId:body.uploadId});}
  return response;
 });
 const remote=await server(t), tokens:Record<string,string[]>={uploads:[],plan:[],status:[]};
 for(const action of ['uploads','plan','status'] as const)for(let i=0;i<(action==='uploads'?250:10);i++)tokens[action].push(await d.token(action,{...grants,namespace:'happytohelp-legacy'}));
 remote.state.door={origin:d.origin,mint:(action:string)=>{const token=tokens[action].shift();assert.ok(token);return token;},state:{plans:planRows}};
 remote.state.exportVendor='happytohelp-legacy';
 assert.equal((await connect(home,remote)).code,0);assert.equal((await cli(home,['legacy-package','add',source.root])).code,0);
 remote.state.tasks=[legacyTask('large-package')];
 const interrupted=await cli(home,['run','--once'],{onSpawn:(running:any)=>{child=running;}});assert.equal(interrupted.signal,'SIGKILL');assert.equal(killed,true);
 const firstChunks=uploads.filter(b=>b.name==='rer-segment'), before=firstChunks.map(b=>[b.bundleSha256,b.index].join(':'));
 // The pending claim replays its still-valid lease, as on an immediate restart.
 const resumed=await cli(home,['run','--once']);assert.equal(resumed.code,0,resumed.stderr);
 const after=uploads.filter(b=>b.name==='rer-segment').map(b=>[b.bundleSha256,b.index].join(':'));
 assert.equal(new Set(after).size,after.length,'no acknowledged or unacknowledged durable chunk is re-sent');assert.ok(after.length>before.length);
 assert.equal(planRows.length,1);assert.equal(d.runtime.native().prepare('SELECT count(*) n FROM ik_door_plans').get()!.n,1);
 assert.equal(d.runtime.native().prepare('SELECT count(*) n FROM native_records').get()!.n,0);assert.ok(readBack>=1);
 const segments=uploads.filter(b=>b.name==='rer-segment');assert.ok(segments.every(b=>b.totalBytes<=QUOTA && b.totalChunks<=32));
 assert.ok(verified.bytes>=5*1024**2);assert.ok(source.manifest.objects.some((o:any)=>o.size>QUOTA));
 const duplicateTokens=d.runtime.native().prepare('SELECT count(*) n FROM ik_door_grants').get()!.n;assert.equal(duplicateTokens,d.requests.length,'each admitted door request used a fresh ES256 grant');
 const completion=remote.state.requests.find((r:any)=>r.route.endsWith('/complete'))!.body.outputs;
 assert.deepEqual(completion,{upload_id:planRows[0].uploadId,plan_id:planRows[0].planId,bundle_sha256:planRows[0].bundleSha256});
 t.diagnostic(`PROBE P1 exit=0 bytes=${verified.bytes} segments=${new Set(segments.map(b=>b.bundleSha256)).size} upload_id=${completion.upload_id} plan_id=${completion.plan_id} bundle_sha256=${completion.bundle_sha256}`);
 t.diagnostic(`PROBE P3 rowCounts=${JSON.stringify(verified.rowCounts)} objects=${verified.objects.count} objectBytes=${verified.objects.bytes} all file SHA-256s match; native writes=0`);
 t.diagnostic(`PROBE P5 SIGKILL after chunk 7; before=${before.length} total=${after.length}; inventory resumed with zero repeated chunk writes`);
});
