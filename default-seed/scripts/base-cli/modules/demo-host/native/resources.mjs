import { hash } from '../../deploy-kit/validation.mjs';
import { cloudflare } from '../../deploy-kit/provider.mjs';
import { r2ObjectPages, r2ObjectPath } from '../../deploy-kit/r2-objects.mjs';
import { uploadWorker } from '../../deploy-kit/worker.mjs';

export const provider = env => cloudflare({accountId:env.DEMO_ACCOUNT_ID,token:env.DEMO_API_TOKEN, fetch:(url,init)=>fetch(url,{...init,redirect:'manual'}), maxRequests:1000});
export const prefix = env => env.DEMO_WORKER.slice(0,15) + '-' + hash(env.DEMO_WORKER).slice(0,8) + '-v-';
export const visitorName = (env, id, ends) => `${prefix(env)}${ends.toString(36)}-${id.slice(0,12)}`;
export async function absent(api, path) {
 try { await api.request(path); return false; } catch (error) { if (error.status === 404) return true; throw error; }
}
async function remove(api, path) {
 try { await api.request(path,{method:'DELETE'}); } catch (error) { if (error.status !== 404) throw error; }
 if (!await absent(api,path)) throw new Error('native-resource-still-present');
}
export async function destroy(env, state) {
 const api = provider(env);
 // Script first: no handler can race a storage deletion.
 await remove(api, `/workers/scripts/${state.name}`);
 for (const db of state.d1 ?? []) await remove(api, `/d1/database/${db.id}`);
 for (const bucket of state.r2 ?? []) {
  for await (const objects of r2ObjectPages(api,bucket.name)) for (const object of objects) {
   await api.request(r2ObjectPath(bucket.name,object.key),{method:'DELETE'});
  }
  await remove(api, `/r2/buckets/${bucket.name}`);
 }
}
export async function upload(env, bundle, state, vars) {
 const bindings = [
  {type:'service',name:'ASSETS',service:env.DEMO_WORKER},
  ...state.d1.map(db=>({type:'d1',name:db.binding,id:db.id})),
  ...state.r2.map(bucket=>({type:'r2_bucket',name:bucket.binding,bucket_name:bucket.name})),
  ...Object.entries({...bundle.vars,...vars}).filter(([name])=>!['SESSION_SECRET','SETUP_TOKEN'].includes(name)).map(([name,text])=>({type:'plain_text',name,text:String(text)})),
 ];
 const secrets = {bindings:[{type:'secret_text',name:'RER_NATIVE_SECRET',text:state.secret},...['SESSION_SECRET','SETUP_TOKEN'].map(name=>({type:'secret_text',name,text:vars[name]}))]};
 await uploadWorker(provider(env), {plan:{worker:state.name,compatibilityDate:bundle.compatibilityDate,compatibilityFlags:bundle.compatibilityFlags},
  artifact:{main:bundle.main,modules:bundle.modules,assets:[]},bindings,secrets,fingerprint:`native-demo-${state.name}`});
 await provider(env).request(`/workers/scripts/${state.name}/subdomain`,{method:'POST',body:{enabled:true,previews_enabled:false}});
}
export function visitorFetch(env, state, path, options = {}) {
 const headers = new Headers(options.headers);
 headers.set('x-rer-native-secret',state.secret);
 return fetch(`https://${state.name}.${env.DEMO_SUBDOMAIN}.workers.dev${path}`,{...options,headers,redirect:'manual'});
}
