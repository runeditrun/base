import front from '../worker.mjs';
import { bundle } from './loader.mjs';
import { HASHED_ASSET } from './config.mjs';
export { HostBridge } from './bridge.mjs';
export { DemoAssets, DemoEgress } from './loader.mjs';
export { NativeDemo } from './visitor.mjs';
export { DemoCapacity } from '../capacity.mjs';

const assets = new Set(bundle.assetPaths);
// The seed's built chunks (its Vite manifest, else its assetsDir) are hashed wherever the build put them.
const chunks = new Set(bundle.immutable);
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.origin !== env.DEMO_ORIGIN && !JSON.parse(env.DEMO_SECONDARY_ORIGINS ?? '[]').includes(url.origin)) return new Response('Not found.', { status: 404 });
    if (['GET', 'HEAD'].includes(request.method) && assets.has(url.pathname)) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      if (chunks.has(url.pathname) || HASHED_ASSET.test(url.pathname)) headers.set('cache-control', 'public, max-age=31536000, immutable');
      headers.set('x-rer-demo-assets', 'edge');
      return new Response(response.body, { status: response.status, headers });
    }
    // The start page prefetches the console's chunks while the visitor waits.
    return front.fetch(request, { ...env, DEMO_WARM: bundle.warm, DEMO_ICON_HEAD: bundle.iconHead }, ctx);
  },
};
