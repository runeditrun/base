import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { nativeDemoPlan } from '../modules/demo-host/native/plan.mjs';
import { prepareNativeDemo } from '../modules/demo-host/native/build.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';
import { awaitCertificates } from '../modules/demo-host/certificate.mjs';
import { TESTING_SECRET } from '../modules/demo-host/measurement.mjs';
import { removeNativeDemo } from '../modules/demo-host/native/remove.mjs';
import { missing, refuse } from './errors.mjs';

export async function nativeDemoCommand(project,options,store,signal,out,operation,app,declaration) {
 const plan=nativeDemoPlan({project:app.project,environment:options.environment??'production',compatibilityDate:app.compatibilityDate,originVar:app.originVar,declaration,turnstileSiteKey:process.env.TURNSTILE_SITE_KEY?.trim()});
 const env=process.env,folder=join(project.root,'.rer/demo-native');
 const api=()=>cloudflare({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
 if (options.remove) {
  await removeNativeDemo(api(),plan);
  return {removed:true,worker:plan.worker};
 }
 await rm(folder,{recursive:true,force:true});await mkdir(folder,{recursive:true,mode:0o700});
 await project.adapter.run(project.root,{},store,()=>{},signal,{verb:'build',operationToken:operation.token,privateSettings:project.adapter.settings??[]});
 await prepareNativeDemo(project.root,folder,app);
 if (!options.dryRun) {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','TURNSTILE_SITE_KEY','TURNSTILE_SECRET_KEY']) if (!env[name]?.trim()) throw missing(`${name} is required for the native demo host.`);
  try {
   const settings=await api().request(`/workers/scripts/${plan.worker}/settings`);
   if (!settings.bindings?.some(binding=>binding.name==='DEMO_MODE'&&binding.text==='native')) throw refuse('This Worker already exists and is not a native demo host.');
  } catch (error) { if (error.status!==404) throw error; }
  const {subdomain}=await api().request('/workers/subdomain');
  Object.assign(plan.wrangler.vars,{DEMO_ACCOUNT_ID:env.CLOUDFLARE_ACCOUNT_ID,DEMO_SUBDOMAIN:subdomain});
 }
 await writeFile(join(folder,'wrangler.json'),JSON.stringify(plan.wrangler,null,2));
 if (options.dryRun) return {dryRun:true,mode:'native',worker:plan.worker,origin:plan.origin};
 const measurement=TESTING_SECRET.test(env.TURNSTILE_SECRET_KEY)?env.RER_DEMO_MEASUREMENT_TOKEN||randomBytes(32).toString('base64url'):undefined;
 if (measurement) await writeFile(join(folder,'measurement-token'),measurement,{mode:0o600});
 // Keep the cookie key across host redeploys: already-running visitors retain access.
 const present=await api().request(`/workers/scripts/${plan.worker}/secrets`).catch(error=>{if(error.status===404)return [];throw error;});
 const secrets={TURNSTILE_SECRET_KEY:env.TURNSTILE_SECRET_KEY,DEMO_API_TOKEN:env.CLOUDFLARE_API_TOKEN,
  ...(!present.some(x=>x.name==='DEMO_COOKIE_SECRET')?{DEMO_COOKIE_SECRET:randomBytes(32).toString('base64url')}:{}),
  ...(measurement?{RER_DEMO_MEASUREMENT_TOKEN:measurement}:{}),...(env.RER_DEMO_OPERATOR_TOKEN?{RER_DEMO_OPERATOR_TOKEN:env.RER_DEMO_OPERATOR_TOKEN}:{})};
 const privateFile=join(folder,'.secrets.json');await writeFile(privateFile,JSON.stringify(secrets),{mode:0o600});
 try {
  const require=createRequire(join(project.root,'package.json')),manifest=require.resolve('wrangler/package.json');
  const wrangler=join(dirname(manifest),JSON.parse(await readFile(manifest,'utf8')).bin.wrangler);
  await store.run('Deploying the native demo host',process.execPath,[wrangler,'deploy','--config','wrangler.json','--secrets-file','.secrets.json','--message',`rer-native-demo:${plan.worker}`],{cwd:folder,signal});
 } finally {await rm(privateFile,{force:true});}
 await awaitCertificates({hostnames:plan.hostnames,report:line=>store.report(line)});
 out.human(`Native demo: ${plan.origin}; one Worker and fresh D1/R2 per visitor, edge assets, 60-minute TTL / 15-minute idle.`);
 return {deployed:true,mode:'native',worker:plan.worker,origin:plan.origin};
}
