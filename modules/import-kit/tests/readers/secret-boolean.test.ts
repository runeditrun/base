import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSource, readApiSource } from '../../src/readers/index.ts';
import { planD1Import, createD1ImportJob, readD1ImportOriginals, resumeD1Import, canonicalJson, sha256 } from '../../src/d1/index.ts';
import { sqliteRuntime, sqliteMapping, sqliteTargets } from '../d1/sqlite-runtime.ts';

test('public readers and durable planning retain boolean secret semantics with exact originals and refuse credential values',async t=>{
  const r=await sqliteRuntime(t);
  const parse=(value:any)=>value.collection.map((payload:any)=>({kind:'record',sourceId:payload.uri,payload}));
  for(const secret of [true,false])for(const api of [false,true]){
    const bytes=Buffer.from(JSON.stringify({collection:[{uri:`https://api.calendly.com/event_types/example-${api}-${secret}`,secret}]}));
    const source=api?await readApiSource({namespace:'archive',url:'https://api.calendly.com/event_types',parsePage:value=>({records:parse(value)})},async()=>new Response(bytes)):await readFileSource({namespace:'archive',name:'event.json',format:'json',bytes,parse});
    const plan=await planD1Import(source,sqliteMapping,r.context());
    const job=await createD1ImportJob(plan,{...r.context(),reviewedFingerprint:plan.fingerprint});
    await resumeD1Import(job.id,r.context());
    const changed=structuredClone(source);
    changed.records[0].payload={secret:'synthetic-credential'};
    changed.records[0].payloadHash=sha256(canonicalJson(changed.records[0].payload));
    await assert.rejects(planD1Import(changed,sqliteMapping,r.context()),/CREDENTIAL_IN_DURABLE_DATA/);
    const original=(await readD1ImportOriginals(job.id,r.context()))[0].original;
    assert.equal(original.status,'retained');
    if(original.status==='retained')assert.deepEqual(Buffer.from(original.base64,'base64'),bytes);
    assert.deepEqual((await sqliteTargets.read(r.db(),'workspace','record',source.records[0].sourceId))!.value,source.records[0].payload);
  }
  for(const secret of ['synthetic-credential',{value:'synthetic-credential'},1]){
    const bytes=Buffer.from(JSON.stringify({collection:[{uri:'https://source.test/event',secret}]}));
    // Inspect raw originals even when the parser intentionally drops metadata.
    await assert.rejects(readFileSource({namespace:'archive',name:'event.json',format:'json',bytes,parse:()=>[]}),/INVALID_OR_CREDENTIAL_SOURCE_DATA/);
    await assert.rejects(readApiSource({namespace:'archive',url:'https://source.test/events',parsePage:()=>({records:[]})},async()=>new Response(bytes)),/INVALID_OR_CREDENTIAL_SOURCE_DATA/);
  }
  // Null, an empty string or a mask where a credential would go is not a credential.
  for(const secret of [null,'','********']){
    const bytes=Buffer.from(JSON.stringify({collection:[{uri:`https://source.test/event-${JSON.stringify(secret)}`,secret}]}));
    const source=await readFileSource({namespace:'archive',name:'event.json',format:'json',bytes,parse});
    assert.deepEqual(source.records[0].payload,{uri:`https://source.test/event-${JSON.stringify(secret)}`,secret});
    assert.equal(source.artifacts[0].original?.status,'available');
    const plan=await planD1Import(source,sqliteMapping,r.context());assert.equal(plan.counts.mapped,1);
  }
  // Refuse mode refuses the common credential shapes the import door removes, naming the field kind.
  const read=(value:Record<string,unknown>)=>readFileSource({namespace:'archive',name:'event.json',format:'json',bytes:Buffer.from(JSON.stringify({collection:[{uri:'https://source.test/event',...value}]})),parse});
  const refused:[Record<string,unknown>,string][]=[
    [{secret_key:'synthetic-credential'},'credential field "secretkey"'],[{headers:{'x-functions-key':'synthetic-credential'}},'credential field "xfunctionskey"'],
    [{headers:{'Ocp-Apim-Subscription-Key':'synthetic-credential'}},'credential field "ocpapimsubscriptionkey"'],[{headers:{'X-Auth':'synthetic-credential'}},'credential field "xauth"'],
    [{pwd:'synthetic-credential'},'credential field "pwd"'],[{apiKeys:['synthetic-credential']},'credential field "apikeys"'],[{tokens:['synthetic-credential']},'credential field "tokens"'],
    [{headers:[['Authorization','Bearer synthetic-credential'],['Accept','*/*']]},'credential field "authorization"'],
    [{link:'https://acct.blob.core.windows.net/c/b?sv=2020-08-04&sig=synthetic-credential'},'URL credential query parameter'],
  ];
  for(const [value,field] of refused) await assert.rejects(read(value),(error:any)=>error.code==='INVALID_OR_CREDENTIAL_SOURCE_DATA'&&error.field===field,field);
  // Look-alike names, counts under a plural name, a lone two-item list and placeholders are accepted as they are.
  const accepted={keyword:'uptime',monkey:'chaos',signal:'green',design:'v2',link:'https://source.test/?signal=1&design=2',tags:['password','reset'],
    tokens:{input:1500,output:300},inputTokens:1500,hasSecretKey:true,pwd:null,secret_key:'',apiKeys:['****'],headers:[['Authorization','none'],['X-Auth','[redacted]']]};
  const source=await read(accepted);
  assert.deepEqual(source.records[0].payload,{uri:'https://source.test/event',...accepted});assert.equal(source.artifacts[0].original?.status,'available');
});
