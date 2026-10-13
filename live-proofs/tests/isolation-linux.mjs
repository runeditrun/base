// Actual Linux/Docker gate. This file contains adversarial test code only.
// It is never imported by a credential-bearing deployment controller.
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Containers,runtimeImages } from '../t016/isolation.mjs';
import { isolationAttestation } from '../t016/trust-boundary.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';
insist(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true','linux-gate-required');
const images = runtimeImages(process.env), containers = new Containers({ ...process.env, T016_CONTAINER_LABEL: 't016-isolation-' + process.env.GITHUB_RUN_ID });
const root = mkdtempSync(join(process.env.RUNNER_TEMP,'t016-isolation-'));
const secret = randomBytes(32).toString('hex'), source = join(root,'source');
mkdirSync(source,{mode:0o755});
const probe = `const fs=require('fs'); const assert=require('assert/strict');
assert(!Object.values(process.env).includes(${JSON.stringify(secret)}));
for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))) {
 try { assert(!fs.readFileSync('/proc/'+pid+'/environ','utf8').includes(${JSON.stringify(secret)})); }
 catch(e) { if(e.code!=='ENOENT'&&e.code!=='EACCES'&&e.code!=='EPERM'&&e.code!=='ESRCH')throw e; }
}
for(const p of ['/broker/build.sock','/controller','/var/run/docker.sock',${JSON.stringify(root)},'/seed/controller-guard']) assert(!fs.existsSync(p));
assert.throws(()=>fs.writeFileSync('/source/mutation','bad'));
assert.throws(()=>fs.writeFileSync('/usr/local/bin/node','bad'));
fs.writeFileSync('/seed/probe-ok','isolated');
`;
writeFileSync(join(source,'probe.cjs'),probe);
writeFileSync(join(source,'package.json'),JSON.stringify({name:'boundary-test-only',version:'1.0.0',scripts:{postinstall:'node probe.cjs',build:'node probe.cjs'}}));
writeFileSync(join(source,'pnpm-lock.yaml'),"lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
try {
 const controller=await containers.create(images.controller,[],{T016_TEST_PROVIDER_SECRET:secret,HOME:'/tmp',PATH:'/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin'});
 await containers.require(['exec',controller,'node','-e',"require('fs').writeFileSync('/seed/controller-guard','untouched')"]);
 const build=await containers.create(images.build,[{source,target:'/source'}],{HOME:'/tmp',PATH:'/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin',CI:'true'});
 await containers.require(['exec',build,'/bin/cp','-R','/source/.','/seed/']);
 await containers.require(['exec',build,'/opt/trusted/bin/pnpm','install','--offline','--frozen-lockfile']);
 await containers.require(['exec',build,'/opt/trusted/bin/pnpm','build']);
 const checked=await containers.require(['exec',build,'/bin/cat','/seed/probe-ok']);
 insist(checked.output.toString()==='isolated','probe-not-executed');
 const untouched=await containers.require(['exec',controller,'/bin/cat','/seed/controller-guard']);
 insist(untouched.output.toString()==='untouched','controller-mutated');
 for(const [image,role] of [[images.controller,'controller'],[images.build,'build'],[images.browser,'browser']]) {
  const container=await containers.create(image,[],{HOME:'/tmp',PATH:'/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin'});
  const node=await containers.require(['exec',container,'node','--version']);
  insist(/^v26\.8\.1\s*$/.test(node.output.toString()),'runtime-node-version');
  if(role!=='browser'){
   const pnpm=await containers.require(['exec',container,'/opt/trusted/bin/pnpm','--version']);
   insist(pnpm.output.toString().trim()==='10.12.4','runtime-pnpm-version');
  }
  if(role==='controller'){
   const wrangler=await containers.require(['exec',container,'/opt/trusted/bin/wrangler','--version']);
   insist(/4\.129\.1/.test(wrangler.output.toString()),'runtime-wrangler-version');
  }
 }
 appendFileSync(process.env.GITHUB_OUTPUT,'attestation='+isolationAttestation(images,process.env.CONTROL_SHA)+'\n');
 console.log('Linux process/filesystem/environment isolation verified with real pnpm lifecycle and build commands.');
} finally { await containers.close(); rmSync(root,{recursive:true,force:true}); }
