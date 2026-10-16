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
