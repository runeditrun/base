import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

// Fault injection in an isolated runtime copy; product checkout is unchanged.
const source=resolve(process.argv[2], 'onboarding');
const root=await mkdtemp(join(tmpdir(), 'preview-invalid-plan-'));
try {
 await symlink(resolve(source,'../modules'),join(root,'modules'),'junction');
 await cp(source, join(root,'onboarding'), {recursive:true, filter:path=>!path.includes('node_modules')});
 await writeFile(join(root,'onboarding/production-plan.mjs'), "import {writeSync} from 'node:fs'; console.log('Using secrets defined in .dev.vars'); writeSync(3,'synthetic-invalid-plan');\n");
 const {previewTarget}=await import(pathToFileURL(join(root,'onboarding/operator-installer.mjs')));
 const [command,args,{runtimePortHandshake,...options}]=previewTarget({origin:'http://127.0.0.1:49999'});
 assert.equal(runtimePortHandshake,true);
 const child=spawn(command,args,{...options,cwd:root});
 let stderr='', stdout='';const messages=[];
 child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.stdout.on('data',chunk=>{stdout+=chunk;});
 child.on('message',message=>messages.push(message));
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.notEqual(code,0);
 assert.equal(stdout,'');
 assert.deepEqual(messages,[]);
 assert.match(stderr,/Using secrets defined in \.dev\.vars/);
 assert.match(stderr,/Resolving the Worker configuration failed\./);
 assert.doesNotMatch(stderr,/SyntaxError|synthetic-invalid-plan/);
 console.log('PASS: invalid fd-3 result uses the fixed failure message, retains stdout diagnostic on stderr and announces no listener.');
} finally {await rm(root,{recursive:true,force:true});}
