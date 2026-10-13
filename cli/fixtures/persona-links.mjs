import assert from 'node:assert/strict';

// Follow only links emitted by the real CLI, with the browser's own cookies.
// A badge switch or signInAs helper would bypass the link exchange under test.
export async function personaLinks({fixture, browser, context, page, origin, ownerLink}) {
 async function emitted(as) {
  const result=await fixture.run(['dev','--as',as,'--port',new URL(origin).port,'--json']);
  const ready=result.stdoutText.trim().split('\n').map(JSON.parse).find(event=>event.event==='ready');
  assert.ok(ready?.openUrl,'reused dev emits a browser link');
  return ready.openUrl;
 }
 async function follow(context,page,link,role) {
  await page.goto(link);
  await page.waitForURL(url=>['/setup','/app'].includes(url.pathname));
  assert.ok(!new URL(page.url()).hash,'the exchange removes the credential fragment');
  const session=await (await context.request.get(origin+'/auth/session')).json();
  assert.equal(session.operator?.role,role,'printed persona link replaces the existing browser identity');
  const settings=await context.request.get(origin+'/auth/settings/identity');
  assert.equal(settings.status(),role==='owner'?200:403,'only the owner can read sign-in settings');
 }
 await follow(context,page,ownerLink,'owner');
 const memberLink=await emitted('member');
 await follow(context,page,memberLink,'member');
 const ownerAgain=await emitted('owner');
 await follow(context,page,ownerAgain,'owner');
 for(const [link,role]of [[memberLink,'member'],[ownerAgain,'owner']]) {
  const fresh=await browser.newContext();
  try{await follow(fresh,await fresh.newPage(),link,role);}finally{await fresh.close();}
 }
}
