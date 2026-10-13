import { createPortabilityHandler } from '../index.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
export default {async fetch(request,env){
  const handler=await createPortabilityHandler({db:env.DB,buckets:{FILES:env.FILES},policy:fixturePolicy,appOrigin:new URL(request.url).origin,
    authorize:req=>req.headers.get('Cookie')===env.TEST_COOKIE?'owner':null});
  const response=await handler(request);
  if(env.TRUNCATE && new URL(request.url).pathname.endsWith('/download')) {
    const reader=response.body.getReader();const first=await reader.read();await reader.cancel();
    return new Response(first.value,response);
  }
  return response??new Response('missing',{status:404});
}};
