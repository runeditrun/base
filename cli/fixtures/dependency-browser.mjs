import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {localVariables} from '../../onboarding/local/environment.mjs';
import {resolve} from 'node:path';
import {chromium,pause} from './reference.mjs';
import {readDevKey} from '../../modules/operator-auth/dev/sign-in-as.mjs';
import {editorGrant} from './dependency-editor.mjs';

async function nativeLogin(context, origin, root) {
 const settings=localVariables(await readFile(resolve(root,'.dev.vars'),'utf8'));
 const proof=createHmac('sha256',settings.SESSION_SECRET).update('local-cli\0sign-in').digest('hex');
 const response=await context.request.post(origin+'/auth/local/cli-session',{headers:{Origin:origin,'x-rer-local-cli':proof},data:{returnTo:'/setup'},maxRedirects:0});
 assert.equal(response.status(),303);
 const key=await readDevKey(root);
 assert.equal((await context.request.post(origin+'/__dev/key',{headers:{Origin:origin},data:{key}})).status(),204);
 const page=await context.newPage();await page.goto(origin+'/setup');
 assert.equal((await (await context.request.get(origin+'/auth/session')).json()).kind,'native');
 return page;
}

async function oidcLogin(context, page, origin, provider, claims={}) {
 const returnTo=claims.email?'/app':'/setup';
 const start=await context.request.post(origin+'/auth/oidc/auth/start',{headers:{Origin:origin},data:{returnTo},maxRedirects:0});
 assert.equal(start.status(),303);
 await page.goto(origin+await provider.grant(start.headers().location,claims));await page.waitForURL(origin+returnTo);
 const session=await (await context.request.get(origin+'/auth/session')).json();
 assert.equal(session.kind,'oidc');assert.equal(session.operator.email,claims.email??'cli-owner@example.test');
}

export async function linkedBrowser(f,origin,provider,env,kind,network) {
 const preview=f.launch(['scripts/rer.mjs','dev','--port',new URL(origin).port,'--non-interactive','--json','--no-queue'],process.execPath,env);
 let browser;
 try {
  const deadline=Date.now()+120000;while(!preview.stdoutText.includes('"event":"ready"')&&preview.exitCode===null&&Date.now()<deadline)await pause(100);
  assert.ok(preview.stdoutText.includes('"event":"ready"'),'dev reaches readiness');
  browser=await chromium.launch();
  const evidence=resolve('evidence/auth-6');await mkdir(evidence,{recursive:true});
  for(const width of [1440,390]) {
   const viewport={width,height:900};
   const native=await browser.newContext({viewport,javaScriptEnabled:false});
   const providerContext=await browser.newContext({viewport});
   const capture=async(page,name)=>{
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:resolve(evidence,`${kind}-${name}-${width}.png`),fullPage:true});
   };
   const post=(context,path,data)=>context.request.post(origin+path,{headers:{Origin:origin},data,maxRedirects:0});
   try {
    const page=await nativeLogin(native,origin,f.root),providerPage=await providerContext.newPage();
    await page.goto(origin+'/auth/settings/identity');
    const save=async()=>{const posted=page.waitForResponse(r=>r.request().method()==='POST' && r.url()===origin+'/auth/settings/identity');await page.getByRole('button',{name:'Save'}).click();assert.equal((await posted).status(),303);await page.waitForLoadState();};
    const setting=page.getByRole('checkbox');assert.equal(await setting.isChecked(),true);
    await setting.uncheck();await save();
    assert.equal((await post(native,'/auth/oidc/auth/start',{})).status(),403);
    await setting.check();await save();await capture(page,'identity');
    await editorGrant(providerPage,origin,403);await editorGrant(page,origin,200);
    await oidcLogin(providerContext,providerPage,origin,provider);
    const memberEmail=`cli-member-${width}@example.test`;
    assert.equal((await post(native,'/auth/invite',{email:memberEmail,displayName:'Member',role:'member'})).status(),202);
    const member=await browser.newContext({viewport});
    try {
     const memberPage=await member.newPage();
     await oidcLogin(member,memberPage,origin,provider,{email:memberEmail,sub:`member-${width}`});
     await editorGrant(memberPage,origin,403);
     assert.equal((await post(member,'/auth/settings/identity',{idpSignIn:false})).status(),403);
    }finally{await member.close();}
    {
     await editorGrant(providerPage,origin,200);
     // Model a changed server-side subject association in the real D1 store.
     // Ordinary session access alone must not retain the owner's editor grant.
     await f.sql("UPDATE oa_external_identities SET subject='superseded-subject' WHERE issuer='https://idp.example.test' AND subject='test-subject'");
     try {
      assert.equal((await providerContext.request.get(origin+'/auth/session')).status(),200);
      await editorGrant(providerPage,origin,403);await capture(providerPage,'editor-refused');
      await editorGrant(page,origin,200);
     }finally{await f.sql("UPDATE oa_external_identities SET subject='test-subject' WHERE issuer='https://idp.example.test' AND subject='superseded-subject'");}
     await editorGrant(providerPage,origin,200);
    }
    for(const action of ['unlink','relink'])assert.equal((await post(providerContext,'/auth/dependencies/'+action,{interface:'oidc-provider@1',issuer:provider.issuer})).status(),403);
    const identity=async()=>(await f.sql('SELECT sector_id FROM rer_dependency_installation; SELECT * FROM oa_external_identities ORDER BY issuer,subject')).map(result=>result.results);
    const [sector,bindings]=await identity();
    network.setUnavailable(true);
    try {
     assert.equal((await post(native,'/auth/oidc/auth/start',{})).status(),502);
     const recovery=await browser.newContext({viewport,javaScriptEnabled:false});
     try {
      const signIn=await nativeLogin(recovery,origin,f.root);await signIn.goto(origin+'/signin');
      assert.equal(await signIn.getByRole('button',{name:/Continue with/}).count(),0);
      await signIn.getByRole('link',{name:'Continue as owner',exact:true}).waitFor();
      await capture(signIn,'provider-unavailable');await signIn.close();
     }finally{await recovery.close();}
     assert.equal((await post(native,'/auth/dependencies/unlink',{interface:'oidc-provider@1'})).status(),200);
     assert.equal((await f.sql("SELECT count(*) n FROM rer_dependency_keys WHERE interface='oidc-provider@1'"))[0].results[0].n,0);
     assert.equal((await providerContext.request.get(origin+'/auth/session')).status(),401);
     await editorGrant(providerPage,origin,403);
     assert.equal((await native.request.get(origin+'/auth/session')).status(),200);
     assert.equal((await post(native,'/auth/oidc/auth/start',{})).status(),403);
     const statusResponse=await native.request.get(origin+'/auth/dependencies/status');assert.equal(statusResponse.status(),200);
     const status=await statusResponse.json();
     assert.equal(status.linked,false);
     assert.equal(status.needsRelink,false);
     assert.equal(status.links.some(link=>link.interface==='oidc-provider@1'),false);
    }finally{network.setUnavailable(false);}
    assert.equal((await post(native,'/auth/dependencies/relink',{interface:'oidc-provider@1',issuer:provider.issuer})).status(),200);
    const linked=await provider.link((path,{method='GET',input}={})=>fetch(origin+path,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})}));
    assert.equal(linked.status,200);
    assert.deepEqual(await identity(),[sector,bindings]);
    assert.equal((await (await native.request.get(origin+'/auth/settings/identity',{headers:{Accept:'application/json'}})).json()).idpSignIn,true);
    assert.equal((await providerContext.request.get(origin+'/auth/session')).status(),401);
    await oidcLogin(providerContext,providerPage,origin,provider);
    await editorGrant(providerPage,origin,200);
    console.log(JSON.stringify({journey:kind,width,noJavaScriptConfirmation:true,providerUnavailable:'native owner admitted',unlink:'key absent; provider 401; native 200',relink:'sector and bindings retained; setting on; new provider session 200',optionalEditor:'native owner 200; matching subject 200; member 403; changed subject 403; revoked 403'}));
   }finally{await native.close();await providerContext.close();}
  }
 }catch(error){throw new Error(String(error.message).replace(/https?:\/\/[^\s"'<>]+/g,'[URL]'));}finally{network.setUnavailable(false);await browser?.close();await f.stop(preview);}
}
