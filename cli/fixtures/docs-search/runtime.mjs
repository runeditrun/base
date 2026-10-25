import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

/** The deployed static Worker and its real assets binding; no search backend. */
export const searchRuntime = ({ source, assets }) => new Miniflare({telemetry:{enabled:false}, ...convertV4MiniflareOptions({
 cf: false, log: new Log(LogLevel.ERROR), workers: [{
  name:'search-site',modules:true,script:source,compatibilityDate:'2026-09-08',
  assets:{directory:assets,binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{html_handling:'auto-trailing-slash',not_found_handling:'404-page'}},
 }],
})});
