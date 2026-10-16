import { WorkerEntrypoint } from 'cloudflare:workers';
import bundle from './bundle.mjs';

export function application(env, ctx, id, runtime) {
  return ctx.facets.get('app', () => ({ class: env.LOADER.get(`${bundle.digest}:${id}`, () => ({
    compatibilityDate: bundle.compatibilityDate, compatibilityFlags: bundle.compatibilityFlags,
    mainModule: '_rer/isolate.js', modules: bundle.modules,
    env: { ...runtime, RER_NATIVE_DB: bundle.database, ASSETS: ctx.exports.DemoAssets({}) },
  })).getDurableObjectClass('DemoApp') }));
}
export class DemoAssets extends WorkerEntrypoint {
  fetch(request) { return this.env.ASSETS.fetch(request); }
}
export { bundle };
