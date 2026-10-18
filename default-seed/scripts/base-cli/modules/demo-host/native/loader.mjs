import { WorkerEntrypoint } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import demoEgress from '../../container/demo-egress.mjs';
import bundle from './bundle.mjs';

// Decode only when a Loader factory needs the modules, once per host isolate.
const bytes = text => {
  const buffer = Buffer.from(text, 'base64');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};
let modules;
const loaderModules = () => modules ??= Object.fromEntries(Object.entries(bundle.modules).map(([name, module]) =>
  [name, 'wasm' in module ? { wasm: bytes(module.wasm) } : 'data' in module ? { data: bytes(module.data) } : module]));

export function loaded(env, ctx, id, runtime) {
  return env.LOADER.get(`${bundle.digest}:${id}`, () => ({
    compatibilityDate: bundle.compatibilityDate, compatibilityFlags: bundle.compatibilityFlags,
    mainModule: '_rer/isolate.js', modules: loaderModules(),
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
    return demoEgress.fetch(request, {
      RER_DEMO: '1',
      RER_DEMO_ORIGINS: JSON.stringify([this.env.DEMO_ORIGIN, ...JSON.parse(this.env.DEMO_SECONDARY_ORIGINS ?? '[]')]),
      SELF: { fetch: request => this.env.DEMO.get(this.env.DEMO.idFromString(this.ctx.props.id)).fetch(request) },
      NETWORK: { fetch: request => fetch(request) },
    });
  }
}
