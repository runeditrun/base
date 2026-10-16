import front from '../worker.mjs';
import { bundle } from './loader.mjs';
export { DemoAssets } from './loader.mjs';
export { NativeDemo } from './visitor.mjs';
export { DemoCapacity } from '../capacity.mjs';

const assets = new Set(bundle.assetPaths);
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.origin !== env.DEMO_ORIGIN) return new Response('Not found.', { status: 404 });
    if (['GET', 'HEAD'].includes(request.method) && assets.has(url.pathname)) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      if (/^\/assets\/.*-[\w-]{8,}\.[\w]+$/.test(url.pathname)) headers.set('cache-control', 'public, max-age=31536000, immutable');
      headers.set('x-rer-demo-assets', 'edge');
      return new Response(response.body, { status: response.status, headers });
    }
    return front.fetch(request, env, ctx);
  },
};
