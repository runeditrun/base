import { destroy, prefix, absent } from './resources.mjs';
import { uploadWorker } from '../../deploy-kit/worker.mjs';

export async function removeNativeDemo(api,plan) {
 if (await absent(api,`/workers/scripts/${plan.worker}/settings`)) return {alreadyRemoved:true};
 const settings=await api.request(`/workers/scripts/${plan.worker}/settings`);
 if (!settings.bindings.some(x=>x.name==='DEMO_MODE'&&x.text==='native')) throw new Error('native-demo-ownership-mismatch');
 const env={DEMO_ACCOUNT_ID:api.accountId,DEMO_API_TOKEN:process.env.CLOUDFLARE_API_TOKEN,DEMO_WORKER:plan.worker};
 const owned=prefix(env);
 const listed=await api.list('/workers/scripts'),host=listed.find(row=>row.id===plan.worker);
 if(typeof host?.migration_tag!=='string')throw new Error('native-demo-migration-tag-missing');
 const scripts=listed.filter(row=>row.id.startsWith(owned));
 for (const script of scripts) await destroy(env,{name:script.id});
 for (const db of await api.list('/d1/database')) if (db.name.startsWith(owned)) await api.request(`/d1/database/${db.uuid}`,{method:'DELETE'});
 for (const bucket of await api.list('/r2/buckets',{field:'buckets',pagination:'r2-bounded'})) if (bucket.name.startsWith(owned)) await destroy(env,{name:bucket.name,r2:[bucket]});
 // A migration removes the DO namespaces and all their data before the front script.
 await uploadWorker(api,{plan:{worker:plan.worker,compatibilityDate:plan.wrangler.compatibility_date},artifact:{main:'empty.mjs',modules:[{path:'empty.mjs',base64:Buffer.from('export default {fetch(){return new Response(null,{status:410})}}').toString('base64')}],assets:[]},bindings:[],secrets:{bindings:[]},migration:{old_tag:host.migration_tag,new_tag:'native-removed',deleted_classes:['NativeVisitor','DemoCapacity','NativeRegistry']},fingerprint:'native-removed'});
 await api.request(`/workers/scripts/${plan.worker}`,{method:'DELETE'});
 const remaining=(await api.list('/workers/durable_objects/namespaces')).filter(row=>row.script===plan.worker);
 if (!await absent(api,`/workers/scripts/${plan.worker}/settings`)||remaining.length) throw new Error('native-demo-removal-incomplete');
 return {removed:true};
}
