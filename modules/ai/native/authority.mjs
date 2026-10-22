import { AiError } from '../errors.mjs';
import { approve, canonical, digest, exact, fail, name, reservation } from './policy.mjs';
import { Ledger } from './ledger.mjs';
import { nativeTransport, requirePrivateBucket, textInput, textResult } from './provider.mjs';
import { adopt, imageEnvelope, imageKey } from './image.mjs';
export const privateHeaders = { 'cache-control':'private, no-store', 'vary':'Cookie, Origin', 'x-content-type-options':'nosniff' };
export const errorResponse = error => Response.json({ error:{ code:error instanceof AiError ? error.code : 'ai_unavailable' } }, {status:error instanceof AiError ? error.status : 503,headers:privateHeaders});
export async function boundedJson(request, maximum = 210000) {
  if (Number(request.headers.get('content-length')) > maximum) fail('ai_invalid_request', 413);
  const reader = request.body?.getReader(); if (!reader) fail('ai_invalid_request', 400);
  const parts = []; let size = 0;
  for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > maximum) { await reader.cancel(); fail('ai_invalid_request', 413); } parts.push(value); }
  try { return JSON.parse(await new Blob(parts).text()); } catch { fail('ai_invalid_request', 400); }
}
/** One instance per installation/environment; tenant never selects a separate budget. */
export class AiAuthority {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.ledger = new Ledger(ctx.storage); }
  policy() {
    let request, authority;
    try { request = JSON.parse(this.env.RER_AI_REQUEST); authority = JSON.parse(this.env.RER_AI_AUTHORITY); } catch { fail('ai_disabled', 503); }
    const policy = approve(request,authority);
    return policy;
  }
  async privacy() {
    return requirePrivateBucket({ accountId:this.env.RER_AI_ACCOUNT_ID,bucketName:this.env.RER_AI_BUCKET_NAME,token:this.env.RER_AI_PRIVACY_TOKEN });
  }
  async fetch(request) {
    try {
      if (request.method !== 'POST') fail('ai_invalid_request', 405);
      const policy = this.policy(), input = await boundedJson(request);
      exact(input, ['action','tenant','purpose','command','input','second']);
      if (input.tenant !== policy.tenant) fail('ai_tenant_refused', 403);
      if (input.action === 'status') { this.ledger.bind(policy,true); return Response.json(this.ledger.snapshot(), {headers:privateHeaders}); }
      if (input.action === 'reconcile') { this.ledger.reconcile(policy); await this.ctx.storage.sync(); return Response.json({reconciled:true}, {headers:privateHeaders}); }
      this.ledger.bind(policy);
      const purpose = policy.purposes.find(p => p.id === input.purpose);
      if (!purpose) fail('ai_purpose_refused', 403);
      if (input.action === 'read') {
        if (purpose.kind !== 'image' || Object.keys(input).some(k => !['action','tenant','purpose'].includes(k))) fail('ai_invalid_request',400);
        await this.privacy();
        const operation = this.ledger.findImage(policy.tenant,purpose.id);
        if (!operation) fail('ai_image_missing',404);
        const key = await imageKey(policy,purpose.id), scope = await digest(canonical([policy.installation,policy.environment,policy.tenant,purpose.id]));
        const object = await adopt(this.env[policy.imageBinding],key,operation,scope);
        if (!object) fail('ai_operation_uncertain');
        return new Response(object.bytes, {headers:{...privateHeaders,'content-type':object.mime}});
      }
      if (!['generate','start','finish','cancel'].includes(input.action) || !name(input.command)) fail('ai_invalid_request',400);
      if (purpose.kind === 'image') await this.privacy();
      const maximum = reservation(policy,purpose);
      // Only currently specified native contracts can be selected. Unknown ids never inherit an adapter.
      if (purpose.kind === 'text' && purpose.model !== '@cf/qwen/qwen3.8-27b') fail('ai_provider_unproven',503);
      if (purpose.kind === 'image' && purpose.model !== '@cf/black-forest-labs/flux-2-dev') fail('ai_provider_unproven',503);
      if (typeof input.input !== 'string' || new TextEncoder().encode(input.input).length > policy.operations.maxInputBytes) fail('ai_invalid_request',400);
      if (input.second !== undefined) fail('ai_invalid_request',400);
      const hash = await digest(canonical([purpose,input.input]));
      const id = await digest(canonical([policy.installation,policy.environment,policy.tenant,purpose.id,purpose.kind === 'image' ? 'stable' : input.command]));
      if (input.action === 'cancel') {
        const operation = this.ledger.operation(id);
        if (!operation || operation.tenant !== policy.tenant || operation.purpose !== purpose.id || operation.kind !== 'text') fail('ai_operation_conflict');
        this.ledger.releaseUnsent(id);
        return Response.json({cancelled:true},{headers:privateHeaders});
      }
      if (input.action === 'finish') {
        if (purpose.kind !== 'text') fail('ai_invalid_request',400);
        const operation = this.ledger.operation(id);
        if (!operation || operation.tenant !== policy.tenant || operation.purpose !== purpose.id || this.ledger.calls(id)[0]?.status !== 'settled') fail('ai_operation_uncertain');
        this.ledger.second(id,hash);
        return this.text(policy,purpose,id,maximum,input.input,1);
      }
      if (purpose.kind === 'text' && input.action !== 'start' || purpose.kind === 'image' && input.action !== 'generate') fail('ai_invalid_request',400);
      const claimed = this.ledger.reserve({id,tenant:policy.tenant,purpose:purpose.id,kind:purpose.kind,digest:hash}, Array.from({length:purpose.kind === 'text' ? 2 : 1}, () => maximum), policy.limits);
      if (purpose.kind === 'image') return await this.image(policy,purpose,claimed,input.input);
      if (!claimed.fresh) fail('ai_operation_uncertain');
      return await this.text(policy,purpose,id,maximum,input.input,0);
    } catch (error) { return errorResponse(error); }
  }
  async invoke(id, child, policy, purpose, input, consume) {
    const fence = await this.ledger.dispatch(id,child);
    if (!fence) fail('ai_operation_uncertain');
    let timer;
    const work = (async () => {
      try {
        const output = await nativeTransport(this.env[policy.binding]).run(purpose.model,input);
        return await consume(output,fence);
      } catch (error) { this.ledger.uncertain(id,child,fence); throw error instanceof AiError ? error : new AiError('ai_operation_uncertain'); }
    })();
    // Work may complete after our deadline. Keep its fenced settlement alive, without retrying.
    this.ctx.waitUntil(work.catch(() => {}));
    try { return await Promise.race([work,new Promise((_,reject) => { timer = setTimeout(() => { this.ledger.uncertain(id,child,fence); reject(new AiError('ai_operation_uncertain',504)); }, policy.operations.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async text(policy,purpose,id,maximum,input,child) {
    try {
      const result = await this.invoke(id,child,policy,purpose,textInput(input,policy), async (output,fence) => {
        const result = textResult(output,maximum);
        this.ledger.settle(id,child,fence,result.actual);
        return result.text;
      });
      return Response.json({result}, {headers:privateHeaders});
    } catch (error) { this.ledger.releaseUnsent(id); throw error; }
  }
  async image(policy,purpose,claimed,prompt) {
    const operation = claimed.operation, key = await imageKey(policy,purpose.id);
    const scope = await digest(canonical([policy.installation,policy.environment,policy.tenant,purpose.id]));
    const stored = await adopt(this.env[policy.imageBinding],key,operation,scope);
    if (stored) {
      // Recovery is possible only when this operation durably recorded validated output before put.
      if (!operation.object_digest) fail('ai_image_collision');
      const call = this.ledger.calls(operation.id)[0];
      this.ledger.uncertain(operation.id,0,call.fence);
      return Response.json({stored:true}, {headers:privateHeaders});
    }
    if (!claimed.fresh) fail('ai_operation_uncertain');
    const body = new FormData(); body.set('prompt',prompt);
    // These fields require an installation-held proof of native interpretation and unit ceiling.
    body.set('width','1024'); body.set('height','1024'); body.set('steps','25');
    const envelope = new Response(body);
    return this.invoke(operation.id,0,policy,purpose,{multipart:{body:envelope.body,contentType:envelope.headers.get('content-type')}}, async (output,fence) => {
      const valid = await imageEnvelope(output);
      this.ledger.object(operation.id,valid.digest,valid.mime);
      await this.ctx.storage.sync();
      await this.privacy();
      const written = await this.env[policy.imageBinding].put(key,valid.bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:valid.mime},customMetadata:{scope,operation:operation.id,digest:valid.digest}});
      if (!written) fail('ai_image_collision');
      this.ledger.uncertain(operation.id,0,fence);
      return Response.json({stored:true}, {headers:privateHeaders});
    });
  }
}
