import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkout } from './owner-deploy.mjs';
import { ownerProvider } from '../../modules/deploy-kit/tests/owner-provider.mjs';
import { fixture, entry } from './business/run-grant.mjs';

// Only the Business exchange, provider and hosted HTTP edge are fake. Persistent
// account state lives in this parent, across expired and fresh CLI processes.
export async function expiryDeploy(t) {
 const business = await fixture(t), provider = ownerProvider();
 const { root, git } = await checkout(t, {
  r2: [{binding:'FILES'}], kv: [{binding:'CACHE'}], queues: [{binding:'JOBS',consumer:{batch_size:10}}],
  durableObjects: [{binding:'ROOM',className:'Room',storage:'sqlite'}], crons:['* * * * *'],
  secrets: ['SETUP_TOKEN','OWNER_EMAIL','SESSION_SECRET'].map(binding => ({binding,environment:binding})),
 });
 const statePath = join(root,'.rer/deploy/production.json');
 let barrier, reached = false;
 const held = new Set(), authorities = [];
 const edge = createServer(async (request, response) => {
  try {
   const destination = new URL(request.headers['x-test-destination']);
   const path = destination.pathname.replace(`/client/v4/accounts/${provider.accountId}`,''), method = request.method;
   const chunks = []; for await (const chunk of request) chunks.push(chunk);
   const bytes = Buffer.concat(chunks), headers = {...request.headers,Origin:request.headers.origin,Authorization:request.headers.authorization};
   if (destination.origin === 'https://api.cloudflare.com' && path !== '/workers/assets/upload') {
    const lease = [...business.state.leases.values()].find(row => `Bearer ${business.state.credentials.get(row.lease_id)}` === headers.Authorization);
    assert.ok(lease, 'provider authority is a minted child');
    assert.ok(Date.parse(lease.credential_expires_at) > Date.now(), 'no expired child reaches the provider');
    authorities.push(business.state.credentials.get(lease.lease_id)); headers.Authorization = `Bearer ${provider.token}`;
   }
   const body = headers['content-type']?.startsWith('multipart/form-data') ? await new Response(bytes,{headers}).formData() : bytes.toString();
   let reply;
   if (destination.pathname === '/auth/bootstrap') {
    assert.equal(JSON.parse(body).token,provider.state.secrets.find(row=>row.name==='SETUP_TOKEN')?.value);
    const db = provider.state.databases[0].db;
    if (db.prepare('SELECT id FROM owner').get()) reply = Response.json({error:'already_initialized'},{status:409});
    else { db.prepare('INSERT INTO owner(id) VALUES (?)').run('owner@example.test'); reply = new Response(null,{status:303}); }
   } else if (destination.pathname === '/api/identity/setup-status') reply = Response.json({setupRequired:!provider.state.databases[0]?.db.prepare('SELECT id FROM owner').get()});
   else reply = await provider.fetch(destination.href,{method,headers,redirect:request.headers['x-test-redirect'],...(!['GET','HEAD'].includes(method)?{body}:{})});
   // Withhold an acknowledged read or response while the credential expires.
   // The CLI catches TERM, so its wrapper must eventually KILL this blocked run.
   const saved = await readFile(statePath,'utf8').then(JSON.parse,()=>null);
   const stop = barrier === 'after-d1' && path === '/d1/database' && method === 'GET' && saved?.owned.d1['fixture-production-db']?.status === 'created'
    || barrier === 'before-upload' && path.endsWith('/assets-upload-session')
    || barrier === 'mid-upload' && path === '/workers/assets/upload'
    || barrier === 'accepted-upload' && path === '/workers/scripts/fixture-production' && method === 'PUT';
   if (stop) { reached = true; held.add(response); response.once('close',()=>held.delete(response)); return; }
   response.writeHead(reply.status,Object.fromEntries(reply.headers)); response.end(Buffer.from(await reply.arrayBuffer()));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
 });
 await new Promise(resolve=>edge.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{edge.closeAllConnections();await new Promise(resolve=>edge.close(resolve));provider.close();});
 await writeFile(join(root,'.node-version'),process.versions.node+'\n');
 await writeFile(join(root,'package.json'),JSON.stringify({engines:{node:process.versions.node},packageManager:'pnpm@10.12.4'}));
 await writeFile(join(root,'adapter.mjs'),`import {ownerDeploy} from ${JSON.stringify(new URL('../deploy.mjs',import.meta.url).href)};
const lifecycle={run:async()=>{},settings:[],hooks:{owner:{}}};
export const commandAdapter={...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root,'OPERATIONS.json'),JSON.stringify({version:2,project:'tests/fixture',runtime:{requirements:[]},requiredEnvironment:[],seedContract:{version:1,profile:'first-party',adapter:'adapter.mjs'},commands:{deploy:{argv:['node','adapter.mjs'],inputs:['adapter.mjs','deploy.json'],effects:'Deploy to the fixture provider.'}}}));
 git('add','.');git('commit','-qm','public deploy fixture');
 const env = {COREPACK_HOME:process.env.COREPACK_HOME ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(),'.cache'),'node/corepack'),AUTH_TEST_DEPLOY_EDGE:`http://127.0.0.1:${edge.address().port}`,AUTH_TEST_DEPLOY_ORIGIN:'https://fixture-production.fixture-account.workers.dev',
  NODE_OPTIONS:`--import=${new URL('./business/register.mjs',import.meta.url).pathname} --import=${new URL('./deploy-network.mjs',import.meta.url).pathname}`,
  SETUP_TOKEN:'synthetic-base-setup-token',OWNER_EMAIL:'owner@example.test',SESSION_SECRET:'synthetic-base-session-secret'};
 const run = async (point) => {
  barrier=point; reached=false;
  business.state.credential=`synthetic-base-child-${business.state.issued+1}`;
  business.state.expiryMs=point?5000:900000;
  const result=await business.run([process.execPath,entry,'deploy','--cwd',root,'--json'],{env});
  for (const response of held) response.destroy(); held.clear();
  return {...result,reached};
 };
 return {root,statePath,provider,business,authorities,run};
}

export function deploymentSummary(provider) {
 const s=provider.state;
 return {
  counts:{d1:s.databases.length,r2:s.buckets.length,kv:s.kv.length,queues:s.queues.length,namespaces:s.namespaces.length,versions:s.versions.length,deployments:s.deployments.length},
  owner:s.databases[0].db.prepare('SELECT id FROM owner').all(),
  secrets:s.secrets.map(({name,value})=>({name,value})).sort((a,b)=>a.name.localeCompare(b.name)),
  bindings:s.settings.bindings.map(row=>({name:row.name,type:row.type})).sort((a,b)=>a.name.localeCompare(b.name)),
  queues:s.queues.map(row=>({name:row.queue_name,consumers:row.consumers.length})),schedules:s.schedules,
 };
}
