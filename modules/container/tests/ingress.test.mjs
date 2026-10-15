import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {incoming,outgoing} from '../ingress.mjs';
test('public ingress trusts forwarded facts only from the configured socket peer',async()=>{
 let trustedProxy;
 const server=createServer(async(req,res)=>{try{const request=await incoming(req,{trustedProxy});outgoing(Response.json({url:request.url,client:request.headers.get('cf-connecting-ip'),forwarded:request.headers.get('forwarded'),ingressOrigin:request.headers.get('x-rer-ingress-origin')}),res);}catch{res.statusCode=400;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const origin='http://127.0.0.1:'+server.address().port,headers={'x-forwarded-host':'app.example.test','x-forwarded-proto':'https','x-forwarded-for':'198.51.100.2, 203.0.113.3','cf-connecting-ip':'192.0.2.1','forwarded':'host=attacker.invalid','x-rer-ingress-origin':'https://attacker.invalid'};
  const untrusted=await(await fetch(origin+'/path',{headers})).json();assert.equal(untrusted.url,origin+'/path');assert.equal(untrusted.client,'127.0.0.1');assert.equal(untrusted.forwarded,null);assert.equal(untrusted.ingressOrigin,null);
  trustedProxy='localhost';const trusted=await(await fetch(origin+'/path',{headers})).json();assert.equal(trusted.url,'https://app.example.test/path');assert.equal(trusted.client,'203.0.113.3');assert.equal(trusted.forwarded,null);assert.equal(trusted.ingressOrigin,null);
  assert.equal((await fetch(origin,{headers:{...headers,'x-forwarded-proto':'file'}})).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('an isolated front selects only an exact allowed HTTPS origin and keeps probes on the primary', async () => {
 const primary = 'https://demo.run-lamp.test', secondary = 'https://page.demo.run-lamp.test';
 let origins = [primary, secondary];
 const server = createServer(async (req, res) => {
  try {
   const request = await incoming(req, { origin: primary, origins });
   outgoing(Response.json({ url: request.url, host: request.headers.get('host'), origin: request.headers.get('origin'),
    ingressOrigin: request.headers.get('x-rer-ingress-origin'), originalUrl: request.headers.get('x-rer-original-url'),
    forwarded: request.headers.get('x-forwarded-host'), body: await request.text() }), res);
  } catch (error) { res.statusCode = error.status ?? 500; res.end(); }
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const address = `http://127.0.0.1:${server.address().port}`;
 try {
  const health = await (await fetch(address + '/health')).json();
  assert.equal(health.url, primary + '/health');
  const claim = await (await fetch(address + '/auth/owner-claim', { method: 'POST', headers: { origin: primary }, body: 'claim' })).json();
  assert.equal(claim.url, primary + '/auth/owner-claim');
  assert.equal(claim.body, 'claim');
  for (const selected of [primary, secondary]) {
   const response = await fetch(address + '/subscribe?component=mail', { method: 'POST', body: 'subscriber', headers: {
    origin: selected, 'x-rer-ingress-origin': selected, 'x-rer-original-url': 'https://attacker.invalid/other',
    'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'http' } });
   assert.equal(response.status, 200);
   const observed = await response.json();
   assert.equal(observed.url, selected + '/subscribe?component=mail');
   assert.equal(observed.host, new URL(selected).host);
   assert.equal(observed.origin, selected, 'the app retains the browser Origin for its own CSRF checks');
   assert.equal(observed.body, 'subscriber');
   assert.equal(observed.ingressOrigin, null);
   assert.equal(observed.originalUrl, null);
   assert.equal(observed.forwarded, null);
  }
  // Even matching allowlist entries cannot smuggle paths, credentials, or an
  // insecure scheme into the application's public authority.
  for (const rejected of ['https://attacker.invalid', 'http://page.demo.run-lamp.test', secondary + '/',
   secondary + '/other', secondary + '?q=1', secondary + '#fragment', 'https://owner@page.demo.run-lamp.test', 'not-an-origin']) {
   origins = rejected === 'https://attacker.invalid' ? [primary, secondary] : [primary, rejected];
   assert.equal((await fetch(address, { headers: { 'x-rer-ingress-origin': rejected } })).status, 400, rejected);
  }
  for (const unconfigured of [undefined, []]) {
   origins = unconfigured;
   assert.equal((await fetch(address, { headers: { 'x-rer-ingress-origin': secondary } })).status, 400);
   assert.equal((await (await fetch(address + '/health')).json()).url, primary + '/health');
  }
 } finally { await new Promise(resolve => server.close(resolve)); }
});
