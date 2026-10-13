import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startInstaller} from './server.mjs';

const manifest={schema:1,title:'Theme fixture',groups:[],fields:[{name:'TEAM_NAME',label:'Workspace name',kind:'text',required:true}],steps:[{type:'extension',id:'configure'}]};
const theme=`@font-face { font-family: Brand; src: url('/fonts/brand.woff2') format('woff2'); font-weight: 100 900; }
:root { --rer-font-body: Brand, Arial, sans-serif; --rer-page: #f3f3ee; --rer-surface: #fffefd; --rer-text: #12372e; --rer-muted: #52695f;
 --rer-border: #6d8178; --rer-focus: #0d302c; --rer-accent: #d7f25b; --rer-accent-text: #12372e; --rer-radius: 24px; --rer-logo: url('/brand/mark.svg'); }`;

async function seedRoot(t,files) {
 const root=await mkdtemp(join(tmpdir(),'installer-theme-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'rer-setup.json'),JSON.stringify(manifest));
 await writeFile(join(root,'background.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
 for(const [path,bytes] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),bytes);}
 return root;
}
const start=(t,root,extra={})=>startInstaller(root,{seed:{product:'Theme fixture',setup:{manifestFile:'rer-setup.json'},background:'background.svg',install:async()=>{},...extra},noPrefill:true}).then(server=>{t.after(()=>server.close());return server;});

test('a seed theme dresses the installer from files the app serves, and an unthemed seed keeps the current page',async t=>{
 const files={'public/rer-theme.css':theme,'public/fonts/brand.woff2':'font-bytes','public/brand/mark.svg':'<svg xmlns="http://www.w3.org/2000/svg"/>','public/private.woff2':'not declared'};
 const themed=await start(t,await seedRoot(t,files),{theme:'public/rer-theme.css'});
 const html=await (await fetch(themed.origin)).text();
 assert.match(html,/<html lang="en" class="rer-themed">/);
 assert.match(html,/<link rel="stylesheet" href="\/style.css"><link rel="stylesheet" href="\/rer-theme.css"><link rel="stylesheet" href="\/theme.css">/);
 for(const [path,type,body] of [['/rer-theme.css','text/css',theme],['/fonts/brand.woff2','font/woff2','font-bytes'],['/brand/mark.svg','image/svg+xml',files['public/brand/mark.svg']]]){
  const response=await fetch(themed.origin+path);
  assert.equal(response.status,200,path);assert.equal(response.headers.get('content-type'),type);assert.equal(await response.text(),body);
 }
 for(const path of ['/private.woff2','/public/rer-theme.css','/fonts/../private.woff2'])assert.equal((await fetch(themed.origin+path)).status,404,path);

 const plain=await start(t,await seedRoot(t,files));
 const plainHtml=await (await fetch(plain.origin)).text();
 assert.doesNotMatch(plainHtml,/rer-themed|rer-theme\.css|theme\.css/);
 for(const path of ['/rer-theme.css','/theme.css'])assert.equal((await fetch(plain.origin+path)).status,404,path);
});

test('a theme outside the grammar, naming files the app does not serve, or failing contrast is refused before the installer starts',async t=>{
 const cases=[
  [theme.replace('--rer-text: #12372e','--rer-text: #d7f25b'),/--rer-text #d7f25b on --rer-page #f3f3ee is 1\.\d+:1, below 4\.5:1/],
  [theme.replace('--rer-focus: #0d302c','--rer-focus: #f3f3ee'),/--rer-focus #f3f3ee on --rer-page #f3f3ee is 1\.00:1, below 3:1/],
  [theme.replace('--rer-accent-text: #12372e;',''),/declare --rer-accent and --rer-accent-text together/],
  [theme+'\nbody { color: red }',/only :root \{ --rer-\* \} and @font-face/],
  [theme.replace("url('/brand/mark.svg')","url('https://cdn.example/mark.svg')"),/--rer-logo must be url\("\/path"\)/],
  [theme.replace('/fonts/brand.woff2','/fonts/missing.woff2'),/names \/fonts\/missing\.woff2, which the app does not serve/],
 ];
 for(const [css,message] of cases){
  const root=await seedRoot(t,{'public/rer-theme.css':css,'public/fonts/brand.woff2':'font-bytes','public/brand/mark.svg':'<svg/>'});
  await assert.rejects(start(t,root,{theme:'public/rer-theme.css'}),message);
 }
 await assert.rejects(start(t,await seedRoot(t,{}),{theme:'../outside.css'}),/root-relative \.css path without \.\./);
});
