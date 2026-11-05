import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { door } from './fixture.ts';
import { createImportDoorHandler, waveInventoryHash } from '../../src/door/index.ts';
import type { ImportDoorBoundedSource } from '../../src/door/index.ts';
import type {ParsedRecord} from '../../src/types.ts';
import { canonicalJson, sha256 } from '../../src/provenance/identity.ts';
import { legacyPackage } from '../../../../cli/fixtures/business/legacy-package.mjs';
import { cli, connect, legacyTask } from '../../../../cli/fixtures/business/legacy-cli.mjs';
import { server } from '../../../../cli/fixtures/business/server.mjs';

const hash=(value:unknown)=>sha256(canonicalJson(value));
/** Business is the synthetic network edge; the CLI subprocess, signed door,
 * package custody, native SQLite application and reconciliation are real. */
export async function boundedCliProof(t:TestContext) {
 const home=await mkdtemp(join(tmpdir(),'.business-connect-bounded-cli-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const legacy=await legacyPackage(join(home,'legacy')),d=await door(t);await d.enable();
 const rows:ParsedRecord[]=[];
 for(const chunk of legacy.manifest.chunks)for(const payload of JSON.parse(legacy.files.get(chunk.file)!.toString()))rows.push({kind:chunk.table,sourceId:String(payload.id),payload});
 const projection=(r:ParsedRecord)=>({table:'native_records',key:`${r.kind}:${r.sourceId}`,valueHash:hash(r.payload),storedBytes:Buffer.byteLength(canonicalJson(r.payload)),blobBytes:0});
 const bounded:ImportDoorBoundedSource={protocol:'rer-bounded-waves/1',
  async describe(upload){const stored=upload.files.reduce((n,f)=>n+f.bytes,0);return {source:rows.length,native:rows.length,aliases:0,objects:2,logicalBytes:stored,storedBytes:stored,nativeBytes:rows.reduce((n,r)=>n+projection(r).storedBytes,0),blobBytes:0,contextBytes:legacy.files.get('context-users.json')!.length,
   children:rows.length,byKind:legacy.manifest.source.rowCounts,nativeByTable:{native_records:rows.length},sourceMode:'complete',highWater:'fixture-snapshot',accountingVersion:'fixture-native-1',baselineHash:hash([]),relationshipsHash:hash(rows.map(()=>hash([]))),
   inventoryHash:waveInventoryHash({source:rows.map(r=>({...r,payloadHash:hash(r.payload)})),native:rows.map(projection),files:upload.files.map(f=>({...f,role:f.path.startsWith('media-')?'object':f.path.startsWith('context-')?'context':'source',logicalBytes:f.bytes}))})};},
  async page(upload,ordinal){
   // Enumerate and verify actual package files through the mounted accessor.
   for(const file of upload.files)assert.deepEqual(Buffer.from(await upload.read(file.path)),legacy.files.get(file.path));
   return {id:`fixture-unit-${ordinal}`,dependsOn:ordinal?[`fixture-unit-${ordinal-1}`]:[],records:[rows[ordinal]],aliases:[],relationshipsHash:hash([]),files:ordinal?[]:upload.files.map(file=>({path:file.path,role:file.path.startsWith('media-')?'object':file.path.startsWith('context-')?'context':'source',logicalBytes:file.bytes}))};
  },
  native(plan){return plan.entries.map(e=>projection(e.source));},
  authority(){return d.ownerPredicate;},
 };
 const aggregates:any[]=[],mount=createImportDoorHandler({...d.options,bounded,package:{formats:['happytohelp-legacy-chunks-v1'],maxBytes:2**20,maxSegments:32,read:async()=>rows},mapping:{version:'v1',map:r=>({effects:[{targetKind:'record',targetId:`${r.kind}:${r.sourceId}`,value:r.payload}]})}});
 let lastSeal:any;
 d.mount(async request=>{const response=await mount(request);if(response?.status===200){const body=await response.clone().json() as any;if(request.url.endsWith('/seal-parent'))lastSeal=body;if(request.url.endsWith('/finalize-parent'))aggregates.push(body);}return response;});
 const remote:any=await server(t),arrangement:any={protocol:'rer-bounded-waves/1',migration:'cli-migration',revision:'cli-revision',policy:'cli-policy'},at=new Date().toISOString();
 const queues:Record<string,string[]>={};
 const tokens=async(action:string,extra:any={},count=24)=>{queues[action]=[];for(let i=0;i<count;i++)queues[action].push(await d.token(action as any,{namespace:'happytohelp-legacy',maxRecords:2,...extra}));};
 for(const action of ['uploads','prepare','seal-parent','wave-status'])await tokens(action,action==='uploads'?{}:{bounded:arrangement});
 remote.state.door={origin:d.origin,mint:(action:string)=>{const token=queues[action]?.shift();assert.ok(token,action);return token;},state:{plans:[],aggregates}};
 remote.state.exportVendor='happytohelp-legacy';
 const connected=await connect(home,remote);assert.equal(connected.code,0,connected.stderr);const registered=await cli(home,['legacy-package','add',legacy.root]);assert.equal(registered.code,0,registered.stderr);
 const task={...legacyTask('bounded-cli'),bounded_waves:arrangement};remote.state.tasks=[task];
 const preview=await cli(home,['run','--once']);
 assert.equal(preview.code,1);assert.match(preview.stderr,/awaiting_parent_approval/);assert.equal(remote.state.released.reason,'paused');
 assert.ok(lastSeal?.fingerprint);assert.equal(d.runtime.native().prepare('SELECT count(*) n FROM native_records').get()!.n,0);assert.equal(aggregates.length,0);
 const parent=lastSeal.fingerprint,pb={protocol:arrangement.protocol,migration:arrangement.migration,revision:arrangement.revision,policy:arrangement.policy,parentFingerprint:parent,parentApprovalRecordId:'cli-parent',parentApprovedAt:at};
 Object.assign(arrangement,{parentId:lastSeal.parentId,parentApproval:{fingerprint:parent,id:'cli-parent',at},children:lastSeal.children.map((c:any)=>({ordinal:c.ordinal,fingerprint:c.fingerprint,approval:{id:`cli-child-${c.ordinal}`,at}}))});
 await tokens('uploads');for(const action of ['seal-parent','wave-status'])await tokens(action,{bounded:pb});
 await tokens('review-parent',{bounded:pb,fingerprint:parent,approvalRecordId:'cli-parent',approvedAt:at});
 await tokens('finalize-parent',{bounded:pb});queues['apply-child']=[];
 for(const child of arrangement.children)queues['apply-child'].push(await d.token('apply-child',{namespace:'happytohelp-legacy',maxRecords:2,bounded:{...pb,childFingerprint:child.fingerprint},fingerprint:child.fingerprint,approvalRecordId:child.approval.id,approvedAt:at}));
 const finished=await cli(home,['run','--once']);assert.equal(finished.code,0,finished.stderr);assert.equal(remote.state.phase,'done');
 assert.equal(aggregates.length,1);assert.equal(aggregates[0].aggregateSuccess,true);assert.equal(d.runtime.native().prepare('SELECT count(*) n FROM native_records').get()!.n,rows.length);
 t.diagnostic('PROBE 5 actual rer business run --once: first command pauses with zero effects awaiting exact review; second command transports inventory, uses six server-approved children under grant=2, and completes only after real destination aggregate reconciliation');
}
