// Uploaded beside the seed's unchanged production bundle. Only the front knows
// the ingress secret. Neither a guessed script name nor app session cookies grant entry.
export function nativeIngress(app) {
 return {
  ...app,
  async fetch(request, env, ctx) {
   if (request.headers.get('x-rer-native-secret') !== env.RER_NATIVE_SECRET || Date.now() >= Number(env.RER_NATIVE_ENDS)) return new Response('Not found', {status:404});
   const url = new URL(request.url);
   if (url.pathname === '/__rer_native/scheduled') {
    if (request.method !== 'POST' || !app.scheduled) return new Response(null, {status:404});
    await app.scheduled({scheduledTime:Date.now(), cron:await request.text(), noRetry() {}}, env, ctx);
    return new Response(null, {status:204});
   }
   const forwarded = new Request(env.RER_NATIVE_ORIGIN + url.pathname + url.search, request);
   forwarded.headers.set('host', new URL(env.RER_NATIVE_ORIGIN).host);
   forwarded.headers.delete('x-rer-native-secret');
   return app.fetch(forwarded, env, ctx);
  },
 };
}
