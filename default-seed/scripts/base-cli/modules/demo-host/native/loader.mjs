import { WorkerEntrypoint } from 'cloudflare:workers';
import bundle from './bundle.mjs';

export function loaded(env, ctx, id, runtime) {
  return env.LOADER.get(`${bundle.digest}:${id}`, () => ({
    compatibilityDate: bundle.compatibilityDate, compatibilityFlags: bundle.compatibilityFlags,
    mainModule: '_rer/isolate.js', modules: bundle.modules,
    globalOutbound: ctx.exports.DemoEgress({ props: { id } }),
    env: { ...runtime, RER_NATIVE_CONFIG: bundle.bindings, RER_NATIVE_HOST: ctx.exports.HostBridge({ props: { id, key: runtime.RER_NATIVE_KEY } }), [bundle.bindings.assets]: ctx.exports.DemoAssets({}) },
  }));
}
export function application(env, ctx, id, runtime) {
  return ctx.facets.get('app', () => ({ class: loaded(env, ctx, id, runtime).getDurableObjectClass('DemoApp') }));
}
export class DemoAssets extends WorkerEntrypoint {
  fetch(request) { return this.env.ASSETS.fetch(request); }
}
export { bundle };

export class DemoEgress extends WorkerEntrypoint {
  fetch(request) {
    const origin = new URL(request.url).origin;
    if (origin === this.env.DEMO_ORIGIN || JSON.parse(this.env.DEMO_SECONDARY_ORIGINS ?? '[]').includes(origin)) {
      return this.env.DEMO.get(this.env.DEMO.idFromString(this.ctx.props.id)).fetch(request);
    }
    return fetch(request);
  }
}
