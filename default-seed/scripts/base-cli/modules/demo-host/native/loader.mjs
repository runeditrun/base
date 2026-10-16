import { WorkerEntrypoint } from 'cloudflare:workers';
import bundle from './bundle.mjs';

export function loaded(env, ctx, id, runtime) {
  return env.LOADER.get(`${bundle.digest}:${id}`, () => ({
    compatibilityDate: bundle.compatibilityDate, compatibilityFlags: bundle.compatibilityFlags,
    mainModule: '_rer/isolate.js', modules: bundle.modules,
    env: { ...runtime, RER_NATIVE_CONFIG: bundle.bindings, RER_NATIVE_HOST: env.DEMO.get(ctx.id), [bundle.bindings.assets]: ctx.exports.DemoAssets({}) },
  }));
}
export function application(env, ctx, id, runtime) {
  return ctx.facets.get('app', () => ({ class: loaded(env, ctx, id, runtime).getDurableObjectClass('DemoApp') }));
}
export class DemoAssets extends WorkerEntrypoint {
  fetch(request) { return this.env.ASSETS.fetch(request); }
}
export { bundle };
