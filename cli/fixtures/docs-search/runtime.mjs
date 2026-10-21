
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

/** Use the actual Cache API and rate-limit binding. Only AI crosses a fake edge. */
export function searchRuntime({ source, assets, network, rateLimit }) {
 return new Miniflare(convertV4MiniflareOptions({
  cf: false,
  log: new Log(LogLevel.ERROR),
  workers: [{
   name: 'search-site', modules: true, script: source, compatibilityDate: '2026-09-08',
   assets: { directory: assets, binding: 'ASSETS', run_worker_first: true, routerConfig:{has_user_worker:true}, assetConfig:{html_handling:'auto-trailing-slash',not_found_handling:'404-page'} },
   ratelimits: { SEARCH_RATE_LIMITER: { namespace_id: rateLimit.namespace_id, simple: rateLimit.simple } },
   serviceBindings: { AI: 'ai-edge' },
  }, {
   name: 'ai-edge', modules: true, compatibilityDate: '2026-09-08',
   script: "import {WorkerEntrypoint} from 'cloudflare:workers'; export default class extends WorkerEntrypoint { async run(model,input) { const response=await fetch("+JSON.stringify(network)+",{method:'POST',headers:{'x-test-destination':'https://api.cloudflare.com/ai/run/'+model},body:JSON.stringify(input)}); if(!response.ok) throw Error('provider refused'); return (await response.json()).result; } }",
  }],
 }));
}
