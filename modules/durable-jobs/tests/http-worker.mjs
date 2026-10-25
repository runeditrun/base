// Test transport only: the maintained Base authentication and jobs mounts own all behavior.
import { durableJobsResponse } from '../../../default-seed/src/core/features/durable-jobs/http.server.ts';
import { authResponse } from '../../../default-seed/src/core/app/auth-http.server.ts';
export default {
  async fetch(envelope, env) {
    const {url,...init}=await envelope.json();
    const request = new Request(url, init);
    if (new URL(request.url).pathname.startsWith('/auth/')) return authResponse(request, env);
    return await durableJobsResponse(request, env) ?? new Response(null, { status: 404 });
  },
};
