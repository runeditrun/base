import { withDevAi } from '../dev/index.mjs';
import { devGate, devNotFound } from '../../operator-auth/dev-gate.mjs';

const worker = withDevAi({ async fetch() { return new Response('Not found', { status: 404 }); } });
export default {
  async fetch(request, env, ctx) {
    const bindings = request.headers.get('x-test-production') ? { ...env, AUTH_LOCAL: 'false', RER_DEV_KEY: undefined } : env;
    if (new URL(request.url).pathname === '/__dev/key') return await devGate({ key: bindings.RER_DEV_KEY, local: bindings.AUTH_LOCAL === 'true', origin: bindings.AUTH_ORIGIN })?.exchange(request) ?? devNotFound();
    return worker.fetch(request, bindings, ctx);
  },
};
