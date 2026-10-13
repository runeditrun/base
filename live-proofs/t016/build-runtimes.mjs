import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { runProcess } from './process.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';

// Preparation only; never invoked by the credential-bearing execution job.
// Local content-addressed image IDs support an independent Linux gate without
// publishing a registry image or inventing a deployment digest.
insist(process.platform === 'linux','linux-runtime-build-required');
const baseImage = process.env.T016_NODE_BASE_IMAGE;
insist(/^node:26\.8\.1-bookworm-slim@sha256:[a-f0-9]{64}$/.test(baseImage ?? ''),'immutable-node-base-required');
const output = resolve(process.argv[2] ?? '');
insist(process.argv.length === 3,'runtime-output-directory-required');
const root = mkdtempSync(join(process.env.TMPDIR || '/tmp','t016-images-'));
const config = join(root,'docker'); mkdirSync(config,{mode:0o700});
const env = { PATH:process.env.PATH,HOME:root,DOCKER_CONFIG:config };
const runtime = new URL('./runtime/',import.meta.url).pathname;
try {
 const images = {};
 for(const role of ['controller','build','browser']){
  const iid=join(root,role+'.iid');
  const result=await runProcess(['docker','build','--platform','linux/amd64','--pull','--iidfile',iid,'--build-arg','NODE_IMAGE='+baseImage,
   '--file',join(runtime,role+'.Dockerfile'),runtime],{env,timeout:1800000});
  insist(result.exitCode===0,'runtime-image-build-failed');
  const id=readFileSync(iid,'utf8').trim();insist(/^sha256:[a-f0-9]{64}$/.test(id),'runtime-image-id-invalid');images[role]=id;
  const prefix=role==='browser'?'/opt/browser':'/opt/trusted';
  const closure=await runProcess(['docker','run','--rm','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges',
   id,'npm','ls','--all','--json','--prefix',prefix],{env});
  insist(closure.exitCode===0,'runtime-dependency-inventory-failed');
  JSON.parse(closure.output.toString());
  writeFileSync(join(output,role+'-dependencies.json'),closure.output,{flag:'wx',mode:0o600});
 }
 writeFileSync(join(output,'runtime-images.json'),JSON.stringify({version:1,baseImage,images},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Runtime images built. Review the dependency inventories and immutable image IDs before running the isolation gate.');
} finally { rmSync(root,{recursive:true,force:true}); }
