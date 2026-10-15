import { appFetch } from './app-fetch.mjs';
// Setup opens app-local approvals before native bootstrap. Existing owners must
// prove possession of their private local session secret through the dev entry.
export async function approveSetupDependencies(context, post) {
 const selected=(context.manifest?.dependencies??[]).filter(d=>context.input[d.address]);
 if(!selected.length)return;
 const failure=()=>Error('Application dependency approval failed. Complete fresh app-owner approval before linking.');
 let cookie;
 const current=await appFetch(new URL('/auth/dependencies/status',context.origin),{signal:context.signal}).then(response=>response.ok?response.json():null);
 const files=process.env.RER_LINK_TOKEN_FILES?JSON.parse(process.env.RER_LINK_TOKEN_FILES):{};
 for(const dependency of selected) {
  const body={interface:dependency.interface,issuer:context.input[dependency.address]};
  if(!process.env.RER_LINK_TOKEN_FILE && !files[dependency.interface] && current?.links?.some(link=>link.interface===body.interface && link.issuer===body.issuer && link.linked))continue;
  const setup=await post(context,'/auth/dependencies/setup',{...body,token:context.vars[context.ownerClaim?.tokenField??'SETUP_TOKEN']});
  if(setup.ok){await setup.body?.cancel();continue;}
  if(setup.status!==409)throw failure();
  await setup.body?.cancel();
  if(!cookie) {
   const confirmed=await post(context,'/auth/local/cli-session',{});
   if(confirmed.status!==303)throw failure();
   cookie=confirmed.headers.get('set-cookie')?.split(';')[0];await confirmed.body?.cancel();
   if(!cookie)throw failure();context.store.addSecrets?.([cookie]);
  }
  const approved=await appFetch(new URL('/auth/dependencies/relink',context.origin),{method:'POST',redirect:'manual',signal:context.signal,headers:{Origin:context.origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  if(!approved.ok)throw failure();await approved.body?.cancel();
 }
}
