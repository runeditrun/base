import assert from 'node:assert/strict';

// Shared by the real exported foundation/default-seed CLI journeys. All calls
// reach their actual Worker, D1 and native sessions; no application fakes.
export async function signedOutSetup(origin) {
 const page=await fetch(origin+'/setup',{redirect:'manual'});
 assert.equal(page.status,303);assert.equal(page.headers.get('location'),'/signin?returnTo=%2Fsetup');
 const post=await fetch(origin+'/setup',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});
 assert.equal(post.status,401,'direct signed-out completion is denied');
}
export async function nonOwnerSetup(context, origin) {
 const response=await context.request.post(origin+'/setup',{headers:{origin},form:{confirm:'yes'},maxRedirects:0});
 assert.equal(response.status(),403,'a real authenticated admin cannot complete owner setup');
}
export async function ownerSetup(context, page, origin) {
 await page.waitForURL(origin+'/setup');
 assert.equal((await context.request.get(origin+'/app/unfinished/deep',{maxRedirects:0})).headers().location,'/setup','all unfinished app paths lead to setup');
 for(const headers of [{origin:''},{origin:'https://attacker.test'},{origin,'sec-fetch-site':'cross-site'}]) {
  assert.equal((await context.request.post(origin+'/setup',{headers,form:{confirm:'yes'},maxRedirects:0})).status(),403,'cross-site or originless completion is denied');
 }
 assert.equal((await context.request.post(origin+'/setup',{headers:{origin},form:{},maxRedirects:0})).status(),400,'confirmation is required');
 assert.equal((await context.request.get(origin+'/setup',{maxRedirects:0})).status(),200,'denied attempts do not complete setup');
 const identity=await (await context.request.get(origin+'/auth/session')).json();
 const submitting=page.waitForResponse(response=>new URL(response.url()).pathname==='/setup'&&response.request().method()==='POST');
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();
 const submitted=await submitting;
 const rejection=await submitted.json().catch(()=>({}));
 const error=typeof rejection.error==='string'&&/^[a-z_]{1,50}$/.test(rejection.error)?rejection.error:'';
 assert.equal(submitted.status(),303,`owner form completion redirects${error?': '+error:''}`);
 assert.equal(submitted.headers().location,'/app');
 await page.waitForURL(origin+'/app');
 assert.deepEqual(await (await context.request.get(origin+'/auth/session')).json(),identity,'completion preserves the owner and native session');
 const revisit=await context.request.get(origin+'/setup?returnTo=https://attacker.test',{maxRedirects:0});
 assert.equal(revisit.status(),303);assert.equal(revisit.headers().location,'/app','completed setup returns to a fixed local app path');
 const repeat=await context.request.post(origin+'/setup',{headers:{origin},form:{confirm:'yes',returnTo:'https://attacker.test'},maxRedirects:0});
 assert.equal(repeat.status(),303);assert.equal(repeat.headers().location,'/app','repeat submission is safe and cannot redirect off-site');
}
