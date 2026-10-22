// Test-only network adapter. Application routing, auth, SQLite and R2 are real.
import { AiAuthority as Authority } from '../native/authority.mjs';
import { nativeAiResponse } from '../../../default-seed/src/core/platform/ai.server.ts';
import { operatorAuth } from '../../../default-seed/src/core/platform/auth/session.server.ts';
import { createAuthHandler } from '../../operator-auth/index.mjs';
export class AiAuthority extends Authority {
  constructor(ctx,env) {
    super(ctx,{...env,AI:{async run(model,input) {
      const response = await fetch('https://provider.test/infer',{method:'POST',body:JSON.stringify({model,input:input.multipart ? 'image' : input})});
      if (!response.ok) throw Error(await response.text());
      return response.json();
    }}});
  }
}
export default { async fetch(envelope,env) {
  const {url,...init} = await envelope.json();
  const request = new Request(url,init);
  const result = await nativeAiResponse(request,env);
  if (result) return result;
  return await createAuthHandler(operatorAuth(env))(request) ?? new Response(null,{status:404});
} };
