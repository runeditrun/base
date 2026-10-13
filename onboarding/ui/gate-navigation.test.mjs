import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startInstaller} from '../server.mjs';
import {createInstallerModel} from '../setup-manifest.mjs';
const {chromium}=createRequire(new URL('../../default-seed/package.json',import.meta.url))('@playwright/test');
async function browserSession(t,manifest){
 const root=await mkdtemp(join(tmpdir(),'gate-browser-'));
 await writeFile(join(root,'rer-setup.json'),JSON.stringify(manifest));
 await writeFile(join(root,'seed.mjs'),"export const product={name:'Gate browser'}; export const features={};");
 await writeFile(join(root,'background.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
 const installer=await startInstaller(root,{seed:{product:'Gate browser',setup:{manifestFile:'rer-setup.json'},browserModule:'seed.mjs',background:'background.svg',install:async()=>{}},noPrefill:true});
 const browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();await installer.close();await rm(root,{recursive:true,force:true});});
 const page=await browser.newPage();page.setDefaultTimeout(4000);
 let token;page.on('request',request=>{token||=request.headers()['x-installer-token'];});
 await page.goto(installer.origin);
 await page.waitForFunction(()=>document.querySelector('#loading')?.hidden===true);
 return {page,installer,post:async(path,value)=>page.request.post(installer.origin+path,{headers:{Origin:installer.origin,'X-Installer-Token':token},data:value})};
}
test('agent answer changes clear every dependent browser-held secret before submission and change-back',async t=>{
 const manifest={schema:1,title:'Agent',groups:[{id:'access',label:'Access',presentations:[{when:{field:'MODE',equals:'first'},label:'First access'},{when:{field:'MODE',equals:'second'},label:'Second access'}]}],fields:[{name:'MODE',label:'Mode',kind:'select',group:'access',required:true,default:'first',options:[{value:'first',label:'First'},{value:'second',label:'Second'}]},...['OPAQUE_ONE','OPAQUE_TWO'].map(name=>({name,label:name,group:'access',kind:'secret',input:'entered',ownerVisible:true,required:true,presentations:[{when:{field:'MODE',equals:'first'}},{when:{field:'MODE',equals:'second'}}]}))],steps:[{type:'extension',id:'agent'}]};
 const {page,post}=await browserSession(t,manifest);

 for(const name of ['OPAQUE_ONE','OPAQUE_TWO'])await page.locator('#'+name).fill('synthetic-browser-private-value');
 assert.equal((await post('/api/prefill',{MODE:'second'})).status(),200);
 await page.waitForFunction(()=>document.querySelector('#heading')?.textContent==='Second access');
 for(const name of ['OPAQUE_ONE','OPAQUE_TWO'])assert.equal((await page.locator('#'+name).inputValue()).length,0);
 await post('/api/prefill',{MODE:'first'});
 await page.waitForFunction(()=>document.querySelector('#heading')?.textContent==='First access');
 for(const name of ['OPAQUE_ONE','OPAQUE_TWO'])assert.equal((await page.locator('#'+name).inputValue()).length,0);
});
test('declared group IDs cannot collide with generated ungrouped, hosting or local-owner groups',async t=>{
 const manifest={schema:1,title:'Collisions',groups:['ungrouped','hosting','local-owner'].map(id=>({id,label:id})),fields:[{name:'FIRST',label:'First',kind:'text',required:true},...['ungrouped','hosting','local-owner'].map((group,index)=>({name:'FIELD_'+index,label:group,kind:'text',required:true,group}))],steps:[{type:'extension',id:'groups'}]};
 const model=createInstallerModel(manifest,{product:{name:'Collision'},features:{hosting:true}},{ownerBootstrap:true});
 assert.equal(new Set(model.setupGroups.map(group=>group.id)).size,model.setupGroups.length);
 const {page}=await browserSession(t,manifest);
 for(const name of ['FIRST','FIELD_0','FIELD_1','FIELD_2']){await page.locator('#'+name).fill('Owner answer');await page.locator('#continue').click();}
 assert.equal(await page.locator('#heading').textContent(),'Ready to install');
});
test('an optional-only group without defaults can be edited from review',async t=>{
 const manifest={schema:1,title:'Optional',groups:[{id:'optional',label:'Optional configuration'}],fields:[{name:'OPTIONAL_NOTE',label:'Optional note',kind:'text',group:'optional'}],steps:[{type:'extension',id:'optional'}]};
 const {page}=await browserSession(t,manifest);
 await page.locator('#known-summary > summary').click();
 await page.getByRole('button',{name:'Edit Optional configuration'}).click();
 await page.locator('#OPTIONAL_NOTE').fill('Owner supplied optional value');
 await page.locator('#continue').click();
 assert.equal(await page.locator('#heading').textContent(),'Ready to install');
 assert.ok((await page.locator('#known').textContent()).includes('Owner supplied optional value'));
});
