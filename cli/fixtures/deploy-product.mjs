import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { checkout, account } from './owner-deploy.mjs';
import { isolatedQueue } from './queue.mjs';

export const productDirectory = '.rer/deploy/product';
export const stagedModule = 'export default {fetch(){return new Response("staged product")}}';
export const stagedHtml = '<h1>Staged product</h1>';

// Produce a real kit product while leaving the checkout's dist in place.
export async function stageProduct(root) {
 const product = join(root, productDirectory);
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(product, path), {recursive:true});
 await writeFile(join(product, 'dist/server/wrangler.json'), await readFile(join(root, 'dist/server/wrangler.json')));
 await writeFile(join(product, 'dist/server/index.js'), stagedModule);
 await writeFile(join(product, 'dist/client/index.html'), stagedHtml);
 await writeFile(join(product, 'migrations/core/0001_owner.sql'), 'CREATE TABLE owner(id TEXT PRIMARY KEY); CREATE TABLE staged_product(id TEXT PRIMARY KEY);');
}

export async function deployProductFixture(t, {custom = true, rootProduct = false, stage = true, declaration = {productDirectory}} = {}) {
 const {root, git} = await checkout(t, {secrets:[{binding:'SETUP_TOKEN', environment:'SETUP_TOKEN'}], ...declaration});
 const saved = {...process.env};
 const {provider, claims} = account(t);
 t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); });
 Object.assign(process.env, await isolatedQueue(t), {CI:'true', SETUP_TOKEN:'test-only-staged-owner-token'});
 if (!rootProduct) await rm(join(root, 'migrations'), {recursive:true});
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({engines:{node:process.versions.node},packageManager:'pnpm@10.12.4'}));
 const source = path => JSON.stringify(new URL(path, import.meta.url).href);
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${source('../deploy.mjs')};
import {main as owner} from ${source('../../modules/deploy-kit/owner-cli.mjs')};
import {stageProduct} from ${JSON.stringify(import.meta.url)};
const build = async root => { ${stage ? 'await stageProduct(root);' : ''} };
const lifecycle = {run:build,settings:[],hooks:{owner:{}}};
export const commandAdapter = {...lifecycle,deployDeclaration:'deploy.json',deploy:${custom ? `async ({root,options}) => {
 await build(root);
 if (options.dryRun) return {dryRun:true,deployed:false};
 return {...await owner(['deploy','--declaration','deploy.json','--environment',options.environment??'production'${rootProduct ? '' : ", '--product', '.rer/deploy/product'"}],process.env,{cwd:root}),deployed:true};
}` : "ownerDeploy('deploy.json',lifecycle)"}};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({version:2,project:'tests/fixture',runtime:{requirements:[]},requiredEnvironment:[],seedContract:{version:1,profile:'first-party',adapter:'adapter.mjs'},commands:{deploy:{argv:['node','adapter.mjs'],inputs:['adapter.mjs','deploy.json'],effects:'Deploy the fixture to the fake provider.'}}}));
 git('add', '.'); git('commit', '-qm', 'staged deployment fixture');
 const assets = [], health = [];
 const fetch = globalThis.fetch;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input);
  if (url.pathname.endsWith('/workers/assets/upload')) for (const [,part] of init.body) assets.push(Buffer.from(await part.text(), 'base64').toString());
  if (url.hostname.endsWith('.workers.dev') && url.pathname === '/health') health.push(url.href);
  return fetch(input, init);
 });
 const run = async (...flags) => {
  const output = [];
  const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  let code;
  try { code = await main(['deploy','--cwd',root,'--json',...flags]); } finally { capture.mock.restore(); }
  const events = output.join('').split('\n').filter(Boolean).map(JSON.parse);
  return {code, events, error:events.find(event => event.event === 'error')?.message};
 };
 return {root, git, provider, claims, assets, health, run};
}
