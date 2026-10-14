import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { providerFixture } from './provider-fixture.mjs';

/** Fake Cloudflare account for owner-account mode tests. It reuses the existing
 * SQLite-backed fixture unchanged and adds Workers KV namespaces, resources that
 * someone else created, and injected failures (an HTTP status or a lost response). */
export function ownerProvider({creationDates = false} = {}) {
  const fixture = providerFixture();
  let created = 0;
  const stamp = () => new Date(Date.UTC(2026,9,8,0,0,created++)).toISOString();
  const {state} = fixture;
  state.kv = [];
  const failures = [];
  let lag = null;
  const prefix = `/client/v4/accounts/${fixture.accountId}`;
  const ok = (result, result_info) => Response.json({success:true,errors:[],result,...(result_info ? {result_info} : {})});
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    const index = failures.findIndex(x => x.method === method && path !== null && x.path.test(path));
    if (index < 0) return handle(input, init);
    const [failure] = failures.splice(index,1);
    state.calls.push({method,path,search:url.search,failed:true});
    // A lost response after the provider already applied the request.
    if (failure.afterApply) { await handle(input,init); throw new TypeError('test-only lost response'); }
    if (failure.transport) throw new TypeError('test-only connection reset');
    return Response.json({success:false,errors:[{code:10000,message:'injected failure'}]},{status:failure.status});
  };
  const handle = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    if (url.origin === 'https://api.cloudflare.com' && path === '/storage/kv/namespaces') {
      if (init.headers?.Authorization !== `Bearer ${fixture.token}`) throw new Error('wrong test credential');
      state.calls.push({method,path,search:url.search});
      if (method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 1);
        return ok(state.kv.slice((page - 1) * 100, page * 100),{page,per_page:100,count:Math.min(100,Math.max(0,state.kv.length - (page - 1) * 100)),total_count:state.kv.length});
      }
      const body = JSON.parse(init.body);
      if (state.kv.some(x => x.title === body.title)) return Response.json({success:false,errors:[{code:10014,message:'exists'}]},{status:400});
      const row = {id:randomUUID().replaceAll('-',''),title:body.title,supports_url_encoding:true};
      state.kv.push(row); state.writes.push({method,path,body}); return ok(row);
    }
    const namespace = path && /^\/storage\/kv\/namespaces\/([^/]+)(\/keys)?$/.exec(path);
    if (url.origin === 'https://api.cloudflare.com' && namespace) {
      state.calls.push({method,path,search:url.search});
      const row = state.kv.find(x => x.id === namespace[1]);
      if (row && namespace[2]) return ok((row.keys ?? []).slice(0,Number(url.searchParams.get('limit') ?? 1000)));
      if (row && method === 'DELETE') { state.kv.splice(state.kv.indexOf(row),1); state.writes.push({method,path}); return ok(null); }
      return row ? ok(row) : Response.json({success:false,errors:[{code:10013,message:'missing'}]},{status:404});
    }
    if (lag && lag.reads > 0 && url.origin === 'https://api.cloudflare.com' && path === '/d1/database' && method === 'GET' && state.databases.length > lag.known) {
      // The account listing runs behind a create: the new database is counted by its rows
      // only ('count', as measured on 13 October 2026) or missing altogether ('omit').
      lag.reads--; state.calls.push({method,path,search:url.search,lagged:true});
      const rows = state.databases.map(({db,...x}) => x), shown = lag.shape === 'omit' ? rows.slice(0,lag.known) : rows;
      return ok(shown,{page:1,total_count:lag.shape === 'omit' ? shown.length : rows.length - 1,total_pages:1});
    }
    if (creationDates && url.origin === 'https://api.cloudflare.com' && path === '/r2/buckets' && method === 'POST') {
      // Real R2 bucket rows carry a creation_date; the shared fixture's rows do not.
      await (await fixture.fetch(input,init)).arrayBuffer();
      const row = state.buckets.find(x => x.name === JSON.parse(init.body).name); row.creation_date = stamp();
      return ok(row);
    }
    return fixture.fetch(input,init);
  };
  return {...fixture, fetch,
    fail(method, path, options = {status:500}) { failures.push({method,path,...options}); },
    /** For its next `reads` listings, the D1 list does not yet show a database created after this call. */
    lagD1(reads, shape = 'count') { lag = {reads,shape,known:state.databases.length}; },
    /** Resources that exist in the account but were not created by the kit. */
    foreign: {
      d1(name) { state.databases.push({uuid:randomUUID(),name,db:new DatabaseSync(':memory:')}); },
      r2(name) { state.buckets.push({name,jurisdiction:'default',storage_class:'Standard',...(creationDates ? {creation_date:stamp()} : {})}); },
      kv(title) { state.kv.push({id:randomUUID().replaceAll('-',''),title,supports_url_encoding:true}); },
      queues(name) { state.queues.push({queue_id:randomUUID().replaceAll('-',''),queue_name:name,consumers:[]}); },
      worker() { state.settings = {bindings:[]}; },
      /** Someone else uploads to the Worker's name: a new version, deployment and etag. */
      replaceWorker() {
        const id = randomUUID(), bindings = [{name:'FOREIGN',type:'plain_text',text:'not-ours'}];
        state.settings = {bindings}; state.version = {id,resources:{bindings,script:{etag:'foreign-etag'}}};
        state.deployments = [{id:randomUUID(),versions:[{version_id:id,percentage:100}]}];
      },
    }};
}
