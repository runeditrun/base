"""One-off equivalent reproduction: the referenced original was not shipped.
Creates a temporary probe in the repo root, uses existing HTTP/ES256/SQLite and
CLI package helpers, and removes the probe. No permanent test is added.
"""
from pathlib import Path
import subprocess
import tempfile

source = r'''
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {door} from './modules/import-kit/tests/door/fixture.ts';
import {createImportDoorHandler,waveInventoryHash} from './modules/import-kit/src/door/index.ts';
import {canonicalJson,sha256} from './modules/import-kit/src/provenance/identity.ts';
import {legacyPackage} from './cli/fixtures/business/legacy-package.mjs';
import {buildPackage,transferPackage} from './cli/business/package-transfer.mjs';
import {door as networkDoor} from './cli/business/vendor-door.mjs';
const hash=(v:any)=>sha256(canonicalJson(v));
test('complete source6/native5 identical routine catch-up retains rejected disposition',async t=>{
 const root=await mkdtemp(join(tmpdir(),'catchup-exclusion-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const legacy=await legacyPackage(join(root,'legacy')),d=await door(t);await d.enable();const db=d.runtime.native();
 const rows:any[]=[];for(const chunk of legacy.manifest.chunks)for(const payload of JSON.parse(legacy.files.get(chunk.file)!.toString()))rows.push({kind:chunk.table,sourceId:String(payload.id),payload});
 const reject=(r:any)=>r.kind==='users', mapped=()=>rows.filter(r=>!reject(r));
 const projection=(r:any)=>({table:'native_records',key:`${r.kind}:${r.sourceId}`,valueHash:hash(r.payload),storedBytes:Buffer.byteLength(canonicalJson(r.payload)),blobBytes:0});
 const role=(p:string)=>p.startsWith('media-')?'object':p.startsWith('context-')?'context':'source';
 const bounded:any={protocol:'rer-bounded-waves/1',
  async describe(upload:any){const stored=upload.files.reduce((n:number,f:any)=>n+f.bytes,0),native=mapped().map(projection),previous=db.prepare("SELECT r.fingerprint FROM ik_door_namespaces n JOIN ik_door_wave_roots r ON r.id=n.head_id WHERE n.namespace='knowledge'").get();return {source:rows.length,native:native.length,aliases:0,objects:2,logicalBytes:stored,storedBytes:stored,nativeBytes:native.reduce((n:number,r:any)=>n+r.storedBytes,0),blobBytes:0,contextBytes:legacy.files.get('context-users.json')!.length,children:rows.length,byKind:legacy.manifest.source.rowCounts,nativeByTable:{native_records:native.length},sourceMode:'complete',highWater:'fixture-snapshot',accountingVersion:'fixture-native-1',baselineHash:previous?.fingerprint??hash([]),relationshipsHash:hash(rows.map(()=>hash([]))),inventoryHash:waveInventoryHash({source:rows.map(r=>({...r,payloadHash:hash(r.payload)})),native,files:upload.files.map((f:any)=>({...f,role:role(f.path),logicalBytes:f.bytes}))})};},
  async page(upload:any,ordinal:number){for(const f of upload.files)assert.deepEqual(Buffer.from(await upload.read(f.path)),legacy.files.get(f.path));return {id:`unit-${ordinal}`,dependsOn:ordinal?[`unit-${ordinal-1}`]:[],records:[rows[ordinal]],aliases:[],relationshipsHash:hash([]),files:ordinal?[]:upload.files.map((f:any)=>({path:f.path,role:role(f.path),logicalBytes:f.bytes}))};},
  native(plan:any){return plan.entries.filter((e:any)=>!reject(e.source)).map((e:any)=>projection(e.source));},authority(){return d.ownerPredicate;}};
 d.mount(createImportDoorHandler({...d.options,bounded,package:{formats:['happytohelp-legacy-chunks-v1'],maxBytes:2**20,maxSegments:32,read:async()=>rows},mapping:{version:'v1',map:r=>reject(r)?{effects:[],rejection:'Unsupported source record'}:{effects:[{targetKind:'record',targetId:`${r.kind}:${r.sourceId}`,value:r.payload}]}}}));
 const signal=new AbortController().signal,quota={maxBytes:65536,maxChunks:1,maxRecords:2},binding={protocol:'rer-bounded-waves/1',migration:'catchup-migration',revision:'baseline',policy:'catchup-policy'},at=new Date().toISOString();
 const files=[...legacy.files].map(([path,bytes])=>({path,file:join(legacy.root,path),bytes:bytes.length,sha256:sha256(bytes)}));
 const prepared=await buildPackage({files,quota:quota.maxBytes,directory:join(root,'package'),source:{format:'happytohelp-legacy-chunks-v1'},records:{total:rows.length,byKind:legacy.manifest.source.rowCounts},totals:{},signal});
 const uploaded=await transferPackage({prepared,signal,fresh:async(action:string)=>({action,destination:`${d.origin}/api/rer/import/${action}`,authorization:'Bearer '+await d.token(action as any,{...quota,...(action==='prepare'?{bounded:binding}:{})} as any)}),request:networkDoor,checkpoint:async()=>{},planAction:'prepare',planInput:{ordinal:0}});
 const send=(action:string,input:any,b:any,extra:any={})=>d.call(action as any,input,{...quota,bounded:b,...extra});
 const prepare=async(b:any,catchup=false)=>{let id='';for(let ordinal=0;ordinal<rows.length;ordinal++){const r=await send('prepare',{...(id?{parentId:id}:{uploadId:uploaded.uploadId,...(catchup?{catchup:true}:{})}),ordinal},b,catchup?{catchup:'bounded',approvalRecordId:'standing',approvedAt:at}:{});assert.equal(r.status,200,JSON.stringify(r.body));id=r.body.parentId;}return id;};
 const complete=async(id:string,b:any)=>{const seal=await send('seal-parent',{parentId:id},b);assert.equal(seal.status,200,JSON.stringify(seal.body));const fp=seal.body.fingerprint,pb={...b,parentFingerprint:fp,parentApprovalRecordId:`parent-${b.revision}`,parentApprovedAt:at};const review=await send('review-parent',{parentId:id},pb,{fingerprint:fp,approvalRecordId:pb.parentApprovalRecordId,approvedAt:at});assert.equal(review.status,200,JSON.stringify(review.body));for(const c of seal.body.children){const r=await send('apply-child',{parentId:id,ordinal:c.ordinal,reviewedFingerprint:c.fingerprint},{...pb,childFingerprint:c.fingerprint},{fingerprint:c.fingerprint,approvalRecordId:`child-${b.revision}-${c.ordinal}`,approvedAt:at});assert.equal(r.status,200,JSON.stringify(r.body));}const result=await send('finalize-parent',{parentId:id},pb);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.aggregateSuccess,true);assert.equal(result.body.nativeSuccess,false);assert.equal(result.body.counts.source,6);assert.equal(result.body.counts.native,5);return result.body;};
 const first=await prepare(binding),baseline=await complete(first,binding);
 const native=()=>db.prepare('SELECT * FROM native_records ORDER BY id').all();const before=hash(native());assert.equal(native().length,5);
 t.diagnostic(JSON.stringify({phase:'baseline',source:baseline.counts.source,native:baseline.counts.native,aggregateSuccess:baseline.aggregateSuccess,nativeSuccess:baseline.nativeSuccess,nativeHash:before}));
 const catchBinding={...binding,revision:'identical-catchup'},second=await prepare(catchBinding,true),seal=await send('seal-parent',{parentId:second},catchBinding);
 t.diagnostic(JSON.stringify({phase:'identical-catchup',preparedPages:6,status:seal.status,error:seal.body.error??null,nativeRows:native().length,nativeHash:hash(native()),unchangedNative:hash(native())===before}));
 assert.equal(hash(native()),before);assert.equal(seal.status,200,JSON.stringify(seal.body));
 const caught=await complete(second,catchBinding);assert.equal(hash(native()),before);assert.equal(caught.dispositions.reused,6);
 t.diagnostic(JSON.stringify({phase:'complete-catchup',source:caught.counts.source,native:caught.counts.native,aggregateSuccess:caught.aggregateSuccess,nativeSuccess:caught.nativeSuccess,reused:caught.dispositions.reused,unchangedNative:hash(native())===before}));
});
'''
with tempfile.NamedTemporaryFile(mode='w',suffix='.test.ts',prefix='.catchup-exclusion-',dir=Path.cwd(),delete=False) as probe:
    probe.write(source)
    path=Path(probe.name)
try:
    result=subprocess.run(['node','--test','--test-concurrency=1',str(path)])
finally:
    path.unlink()
raise SystemExit(result.returncode)
