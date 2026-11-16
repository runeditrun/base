import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkout, manifest } from './owner-deploy.mjs';
import { ownerProvider } from '../../modules/deploy-kit/tests/owner-provider.mjs';
import { createOperatorAuth, createAuthHandler } from '../../modules/operator-auth/index.mjs';
import { database } from '../../modules/operator-auth/identity/oidc/tests/runtime.mjs';
import { main } from '../main.mjs';

// A native uploader resolves its own resource names, then keeps the kit's
// ownership record. The real auth handler serves that Worker's SQLite-backed D1.
export async function namedOwnerDeploy(t, prefix) {
 const secrets = ['OWNER_EMAIL', 'SETUP_TOKEN', 'SESSION_SECRET'].map(name => ({binding:name,environment:name}));
 const { root, git } = await checkout(t, { secrets });
 const provider = ownerProvider(), requests = [];
 const saved = { ...process.env };
 t.after(() => {
  for (const name of Object.keys(process.env)) if (!Object.hasOwn(saved,name)) delete process.env[name];
  Object.assign(process.env,saved); provider.close();
 });
 for (const name of Object.keys(process.env)) if (/^(CLOUDFLARE_|CF_)/.test(name) || secrets.some(item => item.environment === name)) delete process.env[name];
 Object.assign(process.env, {CI:'true',HOME:root,CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token});
 if (prefix) process.env.LAMP_RESOURCE_PREFIX = prefix; else delete process.env.LAMP_RESOURCE_PREFIX;
 await writeFile(join(root,'migrations/core/0001_owner.sql'), await readFile(new URL('../../modules/operator-auth/accounts/schema/operator-auth.sql',import.meta.url)));
 await writeFile(join(root,'migrations/core/0002_signin.sql'), await readFile(new URL('../../modules/operator-auth/accounts/schema/owner-signin.sql',import.meta.url)));
 const module = path => JSON.stringify(new URL(path,import.meta.url).href);
 await writeFile(join(root,'adapter.mjs'), `
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {cloudflare} from ${module('../../modules/deploy-kit/provider.mjs')};
import {ownerTarget,ownerPlan,ownerDeploy} from ${module('../../modules/deploy-kit/owner.mjs')};
import {packageBuild} from ${module('../../modules/deploy-kit/prepare.mjs')};
export const commandAdapter={settings:[],run:async()=>{},hooks:{owner:{}},deployDeclaration:'deploy.json',
 async deploy({root,options}) {
  const environment=options.environment??'production';
  const declaration=JSON.parse(await readFile(join(root,'deploy.json'),'utf8'));
  const api=cloudflare({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});
  const derived=await ownerTarget(api,{project:declaration.project,environment});
  const worker=process.env.LAMP_RESOURCE_PREFIX ? process.env.LAMP_RESOURCE_PREFIX+'-'+environment : derived.worker;
  const target={...derived,worker,origin:derived.origin.replace(derived.worker+'.',worker+'.')};
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  const artifact=await packageBuild({root,source:{sha:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')},runIdentity:{id:'0',attempt:'1'},productDirectory:''});
  const state=join(root,'.rer/deploy/native',environment+'.json');
  const {receipt}=await ownerDeploy({api,target,plan:ownerPlan(target,declaration,artifact),artifact,statePath:state,env:process.env});
  return {deployed:true,origin:receipt.origin,state};
 }};`);
 await writeFile(join(root,'setup.json'),JSON.stringify(manifest));
 await writeFile(join(root,'.node-version'),process.versions.node);
 await writeFile(join(root,'package.json'),JSON.stringify({engines:{node:process.versions.node},packageManager:'pnpm@10.12.4'}));
 await writeFile(join(root,'OPERATIONS.json'),JSON.stringify({version:2,project:'tests/fixture',runtime:{requirements:[]},requiredEnvironment:[],
  seedContract:{version:1,profile:'first-party',adapter:'adapter.mjs',setup:'setup.json'},
  commands:{deploy:{argv:['node','adapter.mjs'],inputs:['adapter.mjs','deploy.json'],effects:'Deploy to the fixture account.'}}}));
 git('add','.'); git('commit','-qm','native deploy fixture');
 const worker = `${prefix ?? 'fixture'}-production`;
 t.mock.method(globalThis,'fetch',async (input,init={}) => {
  const url = new URL(input), named = /\/workers\/scripts\/([^/]+)/.exec(url.pathname)?.[1];
  requests.push({method:init.method??'GET',path:url.pathname,worker:named});
  // The provider fake has one app Worker. Make its name meaningful so asking
  // for the derived sibling cannot accidentally pass against the same state.
  if (named && named !== worker) return Response.json({success:false,errors:[]},{status:404});
  if (url.hostname.endsWith('.workers.dev') && url.pathname.startsWith('/auth/')) {
   if (url.hostname !== `${worker}.owner-account.workers.dev`) throw Error('wrong app Worker');
   const vars=Object.fromEntries(provider.state.settings.bindings.filter(item=>item.type==='plain_text').map(item=>[item.name,item.text]));
   const values=Object.fromEntries(provider.state.secrets.map(item=>[item.name,item.value]));
   const db=provider.state.databases[0].db;
   const auth=createOperatorAuth({db:database(db),config:{...vars,...values,origin:url.origin},clientIp:()=> '192.0.2.1'});
   return createAuthHandler(auth)(new Request(input,{...init,headers:{Host:url.host,...init.headers}}));
  }
  return provider.fetch(input,init);
 });
 const run = async (verb='deploy',...flags) => {
  const lines=[];
  const stdout=t.mock.method(process.stdout,'write',chunk=>{lines.push(String(chunk));return true;});
  const stderr=t.mock.method(process.stderr,'write',chunk=>{lines.push(String(chunk));return true;});
  let code;
  try { code=await main([verb,'--cwd',root,'--json',...flags]); }
  finally { stdout.mock.restore(); stderr.mock.restore(); }
  const events=lines.join('').trim().split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
  return {code,events,result:events.at(-1),text:lines.join('')};
 };
 return {root,git,provider,requests,worker,run,statePath:join(root,'.rer/deploy/native/production.json')};
}
