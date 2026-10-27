import { namedSteps, caseRows } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import WebSocket from 'ws';
import { startHost } from '../host.mjs';

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-websocket-'));
 t.after(() => rm(root, { recursive:true, force:true }));
 for (const dir of ['dist/server','dist/client','data']) await mkdir(join(root,dir), { recursive:true });
 await writeFile(join(root,'data/host.lock'), '');
 await writeFile(join(root,'dist/server/index.mjs'), `
  export default {fetch(request, env) {
   if(request.headers.get('cookie') !== 'session=' + env.VISITOR) return new Response('Sign in required', {status:401, headers:{'set-cookie':'session=; Max-Age=0'}});
   if(new URL(request.url).pathname === '/refuse') return new Response('Origin denied', {status:403});
   if(request.headers.get('origin') !== new URL(request.url).origin) return new Response('Origin denied', {status:403});
   const pair = new WebSocketPair(), peer = pair[1]; peer.binaryType = "arraybuffer"; peer.accept();
   peer.addEventListener('message', event => {
    if(event.data === 'close') peer.close(4001, 'Access changed');
    else peer.send(event.data);
   });
   peer.send('visitor:' + env.VISITOR);
   return new Response(null, {status:101, webSocket:pair[0], headers:{'set-cookie':'visited=1; HttpOnly', 'sec-websocket-protocol':request.headers.get('sec-websocket-protocol')?.includes('echo')?'echo':''}});
  }};
 `);
 await writeFile(join(root,'container.json'), JSON.stringify({engine:'workerd',entry:'dist/server/index.mjs',config:{compatibility_date:'2026-09-01',assets:{run_worker_first:true}},migrations:{}}));
 const start = async visitor => {
  const data = join(root,visitor); await mkdir(data); await writeFile(join(data,'host.lock'),'');
  const host = await startHost({root,data,port:0,automaticTicks:false,settings:{VISITOR:visitor,TRUSTED_PROXY:'127.0.0.1'}});
  t.after(() => host.close());
  return {host, url:'ws://127.0.0.1:' + host.server.address().port};
 };
 return start;
}
function connect(t, url, visitor, options={}) {
 const ws = new WebSocket(url, ['unused','echo'], {headers:{cookie:'session='+visitor,origin:'https://app.example.com','x-forwarded-host':'app.example.com','x-forwarded-proto':'https',...options}});
 t.after(() => ws.terminate()); return ws;
}
function refused(url, headers={}) {
 return new Promise((resolve,reject) => {
  const req = request(url.replace('ws:','http:'), {headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-key':randomBytes(16).toString('base64'),'sec-websocket-version':'13',origin:'https://app.example.com','x-forwarded-host':'app.example.com','x-forwarded-proto':'https',...headers}}, res => {
   let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
  });req.on('error',reject);req.end();
 });
}

test("container WebSocket upgrades preserve the app protocol, authentication and isolated visitor streams", async t => {
  await caseRows(t, [["container WebSocket upgrades preserve the app protocol, authentication and isolated visitor streams", async t => {
  const step = namedSteps(t);
  await step('container upgrades preserve app sends, text/binary echo, protocol, cookies and close in both directions', {timeout:30000}, async t => {
   const {host,url} = await (await fixture(t))('alice');
   const ws = connect(t,url,'alice'), greeting = once(ws,'message'), upgraded = once(ws,'upgrade');
   await once(ws,'open');
   assert.equal(ws.protocol,'echo'); assert.deepEqual((await upgraded)[0].headers['set-cookie'],['visited=1; HttpOnly']);
   assert.equal((await greeting)[0].toString(),'visitor:alice');
   let message=once(ws,'message');ws.send('hello');assert.equal((await message)[0].toString(),'hello');
   message=once(ws,'message');ws.send(Buffer.from([0,255,1]));const [bytes,binary]=await message;assert.equal(binary,true, 'received bytes: '+bytes.toString('hex'));assert.deepEqual(bytes,Buffer.from([0,255,1]));
   let closed=once(ws,'close');ws.send('close');assert.deepEqual(await closed,[4001,Buffer.from('Access changed')]);
   const clientClose=connect(t,url,'alice');await once(clientClose,'open');closed=once(clientClose,'close');clientClose.close(1000,'Done');assert.deepEqual(await closed,[1000,Buffer.from('Done')]);
   const shutdown=connect(t,url,'alice');await once(shutdown,'open');closed=once(shutdown,'close');await host.close();await closed;
  });

  await step('container upgrade refusals retain HTTP status and use HTTP ingress/auth checks', {timeout:30000}, async t => {
   const {url} = await (await fixture(t))('alice');
   let result=await refused(url+'/refuse',{cookie:'session=alice',upgrade:'WebSocket'});assert.equal(result.status,403);assert.equal(result.body,'Origin denied');
   result=await refused(url);assert.equal(result.status,401);assert.ok(result.headers['set-cookie']);
   result=await refused(url,{upgrade:'h2c'});assert.equal(result.status,400);
   result=await refused(url,{cookie:'session=alice',origin:'https://evil.example.com'});assert.equal(result.status,403);
  });

  await step('a socket authenticated for one visitor cannot enter another container', {timeout:30000}, async t => {
   const start=await fixture(t), alice=await start('alice'), bob=await start('bob');
   assert.equal((await refused(bob.url,{cookie:'session=alice'})).status,401);
   assert.equal((await refused(alice.url,{cookie:'session=bob'})).status,401);
   const a=connect(t,alice.url,'alice'), b=connect(t,bob.url,'bob'), am=once(a,'message'),bm=once(b,'message');
   await Promise.all([once(a,'open'),once(b,'open')]);assert.equal((await am)[0].toString(),'visitor:alice');assert.equal((await bm)[0].toString(),'visitor:bob');
   const echoed=once(a,'message');a.send('alice-only');assert.equal((await echoed)[0].toString(),'alice-only');
  });

  }]]);
})
