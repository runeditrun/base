import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { retainStartupFailure } from './command-diagnostic.mjs';

// Follow only links emitted by the real CLI, with the browser's own cookies.
// A badge switch or signInAs helper would bypass the link exchange under test.
export async function personaLinks({fixture, browser, context, page, origin, ownerLink}) {
 async function emitted(as) {
  const result=await fixture.run(['dev','--as',as,'--port',new URL(origin).port,'--json']);
  const ready=result.stdoutText.trim().split('\n').map(JSON.parse).find(event=>event.event==='ready');
  if (!ready?.openUrl) await retainStartupFailure(fixture.root, result);
  assert.ok(ready?.openUrl,'reused dev emits a browser link');
  return ready.openUrl;
 }
 async function follow(context,page,link,email,role) {
  await page.goto(link);
  await page.waitForURL(url=>['/setup','/app'].includes(url.pathname));
  assert.ok(!new URL(page.url()).hash,'the exchange removes the credential fragment');
  const session=await (await context.request.get(origin+'/auth/session')).json();
  assert.deepEqual([session.operator?.email,session.operator?.role],[email,role],'printed link selects the requested account');
  const settings=await context.request.get(origin+'/auth/settings/identity');
  assert.equal(settings.status(),role==='owner'?200:403,'only the owner can read sign-in settings');
 }
 const owner=await (await context.request.get(origin+'/auth/session')).json();
 const savedPath=join(fixture.root,'.rer/local/open-url'),savedLink=await readFile(savedPath);
 const memberLink=await emitted('member');
 const ownerAgain=await emitted('owner');
 assert.ok(savedLink.equals(await readFile(savedPath)),'the ordinary owner link stays in the checkout');
 assert.deepEqual(await (await context.request.get(origin+'/auth/session')).json(),owner,'issuing links preserves the existing owner session');
 for(const [link,email,role]of [[memberLink,'member@dev.localhost','member'],[ownerAgain,owner.operator.email,'owner']]) {
  assert.equal(new URLSearchParams(new URL(link).hash.slice(1)).has('rer-dev'),false,'explicit links exclude the checkout key');
  const fresh=await browser.newContext();
  try {
   await follow(fresh,await fresh.newPage(),link,email,role);
   for(const path of ['/__dev/personas','/auth/dev/enter?as=owner','/auth/one-click?as=member%40dev.localhost']) {
    assert.equal((await fresh.request.get(origin+path,{maxRedirects:0})).status(),404,'a scoped session cannot use the checkout-wide sign-in gate');
   }
  }finally{await fresh.close();}
 }
 await follow(context,page,memberLink,'member@dev.localhost','member');
 await follow(context,page,ownerLink,owner.operator.email,'owner');
}
