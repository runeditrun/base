import { DurableObject } from 'cloudflare:workers';
import { cronMatches } from '../../../cli/scheduled.mjs';
import { provider, prefix, destroy } from './resources.mjs';

export class NativeRegistry extends DurableObject {
 async add(id, ends) { await this.ctx.storage.put(id,ends); }
 async drop(id) { await this.ctx.storage.delete(id); }
 async tick(at) {
  const bundle=await (await this.env.ASSETS.fetch('https://bundle.invalid/__rer_native/bundle.json')).json();
  for (const [id,ends] of await this.ctx.storage.list()) {
   if(!/^[a-f0-9]{64}$/.test(id))continue;
   const visitor=this.env.DEMO.get(this.env.DEMO.idFromString(id));
   if (ends<=at) await visitor.end();
   else for (const cron of bundle.crons) if (cronMatches(cron,new Date(at))) await visitor.tick(cron,at);
  }
  if(at-(await this.ctx.storage.get('swept')??0)>=300000){await this.sweep(at);await this.ctx.storage.put('swept',at);}
 }
 async sweep(at=Date.now()) {
  const api=provider(this.env),owned=prefix(this.env);
  const expired=name=>name.startsWith(owned)&&Number.parseInt(name.slice(owned.length).split('-')[0],36)<at;
  // Names encode their absolute deadline. Only this host's prefix is eligible.
  // This also catches a lost API response before its resource id was saved.
  for (const script of await api.list('/workers/scripts')) if (expired(script.id)) await destroy(this.env,{name:script.id});
  for (const db of await api.list('/d1/database')) if (expired(db.name)) {
   await api.request(`/d1/database/${db.uuid}`,{method:'DELETE'});
  }
  for (const bucket of await api.list('/r2/buckets',{field:'buckets',pagination:'r2-bounded'})) if (expired(bucket.name)) {
   await destroy(this.env,{name:bucket.name.replace(/-[^-]+$/,''),r2:[bucket]});
  }
 }
 async empty() { return [...await this.ctx.storage.list()].every(([key])=>key==='swept'); }
}
