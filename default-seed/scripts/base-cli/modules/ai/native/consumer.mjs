import { requirePost, requireOrigin } from '../../operator-auth/http.mjs';
import { approve, exact, fail, canonical } from './policy.mjs';
import { boundedJson, errorResponse, privateHeaders } from './authority.mjs';
/** Pair with the adopting app's real auth service. Tenant comes from server authority. */
export function createNativeAiConsumer({env,auth,origin,request:declaration,authority,mode = 'disabled',prepareSecond}) {
  async function call(request,input) {
    if (input.action === 'read') {
      requireOrigin(request,{origin});
      if (request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.has('origin') && request.headers.get('origin') !== origin) fail('ai_origin_refused',403);
    }
    else requirePost(request,{origin});
    const session = await auth.getSession(request);
    if (!session || session.operator?.role !== 'owner' || session.operator?.status !== 'active') fail('ai_owner_required',403);
    if (!['owner-account'].includes(mode) || env.RER_DEMO || env.AUTH_LOCAL === 'true') fail('ai_hosting_unproven',503);
    const policy = approve(declaration,authority);
    if (canonical(JSON.parse(env.RER_AI_REQUEST ?? 'null')) !== canonical(declaration) || canonical(JSON.parse(env.RER_AI_AUTHORITY ?? 'null')) !== canonical(authority)) fail('ai_policy_conflict');
    const binding = env[policy.budgetBinding];
    if (!binding?.idFromName || !binding?.get) fail('ai_binding_missing',503);
    // No tenant or command key may select a new budget instance.
    const instance = binding.get(binding.idFromName(canonical([policy.installation,policy.environment])));
    const send = body => instance.fetch(new Request('https://ai.internal/',{method:'POST',body:JSON.stringify({...body,tenant:policy.tenant})}));
    if (input.action !== 'text') return send(input);
    if (typeof prepareSecond !== 'function') fail('ai_second_call_unavailable',503);
    const first = await send({...input,action:'start'});
    if (!first.ok) return first;
    let second;
    try { second = await prepareSecond((await first.json()).result,input.input); }
    catch { await send({...input,action:'cancel'}); fail('ai_second_call_unavailable',503); }
    // Reauthorize before the second effect as well. Reserved work is retained if auth was revoked.
    const current = await auth.getSession(request);
    if (!current || current.operator?.id !== session.operator.id || current.operator?.role !== 'owner' || current.operator?.status !== 'active') fail('ai_owner_required',403);
    if (second === null) { await send({...input,action:'cancel'}); return Response.json({result:null}, {headers:privateHeaders}); }
    return send({...input,action:'finish',input:second});
  }
  return { async handle(request) {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some(k => k !== 'purpose') || url.searchParams.getAll('purpose').length !== 1) fail('ai_invalid_request',400);
        return await call(request,{action:'read',purpose:url.searchParams.get('purpose')});
      }
      // Refuse unauthenticated bodies before buffering site data.
      requirePost(request,{origin});
      const session = await auth.getSession(request);
      if (session?.operator?.role !== 'owner' || session?.operator?.status !== 'active') fail('ai_owner_required',403);
      const input = await boundedJson(request);
      exact(input,['action','purpose','command','input']);
      if (!['text','generate','status','reconcile'].includes(input.action)) fail('ai_invalid_request',400);
      return await call(request,input);
    } catch (error) { return errorResponse(error); }
  } };
}
