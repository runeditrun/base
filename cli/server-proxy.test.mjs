import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { trafficProxy } from './server-proxy.mjs';

function request(port,path='/',{method='GET',body,headers={}}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path,method,headers:{connection:'keep-alive',...headers},agent:false},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('error',reject);
   res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
  });
  req.once('error',reject);req.end(body);
 });
}

// Only the network edge is synthetic: real public listener, pool, HTTP parsers,
// streaming requests/responses and lifecycle accounting run unchanged.
test('public proxy reuses connections, recovers a stale read once, and never replays a streamed write', {timeout:15000}, async t=>{
 let accepts=0,drop=false,alwaysDrop=false,begins=0,finishes=0,release;
 const sockets=new Set(),seen=[],counts=new Map();
 const runtime=http.createServer((req,res)=>{
  counts.set(req.socket,(counts.get(req.socket)??0)+1);
  seen.push({method:req.method,url:req.url,socket:req.socket,headers:req.headers});
  // The runtime closes the formerly idle connection just as its next request
  // arrives: a deterministic version of the FIN/reuse race, before any reply.
  if(drop||alwaysDrop){drop=false;req.socket.destroy();return;}
  if(req.url==='/stream'){res.writeHead(200);res.write('first');release=()=>res.end('last');return;}
  if(req.url==='/restricted'){res.writeHead(403);res.end('<h1>403 Restricted</h1>private allow list');return;}
  if(req.url==='/forbidden'){res.writeHead(403);res.end('application denial');return;}
  let body='';req.on('data',chunk=>{body+=chunk;});
  req.on('end',()=>{res.writeHead(200,{'set-cookie':['a=1','b=2'],'x-runtime':'preserved','cache-control':'no-store'});res.end(body||'ok');});
 });
 runtime.on('connection',socket=>{accepts++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
 const proxy=await trafficProxy({host:'127.0.0.1',port:0,target:runtime.address().port,activity:{begin(){begins++;return()=>{finishes++;};}}});
 t.after(async()=>{await proxy.close();runtime.closeAllConnections();await new Promise(resolve=>runtime.close(resolve));});
 const first=await request(proxy.port,'/headers',{headers:{host:'demo.localhost',origin:'http://demo.localhost',cookie:'session=synthetic-proxy-1'}});
 assert.equal(first.body,'ok');assert.deepEqual(first.headers['set-cookie'],['a=1','b=2']);
 assert.equal(seen[0].headers.host,'demo.localhost');assert.equal(seen[0].headers.origin,'http://demo.localhost');assert.equal(seen[0].headers.cookie,'session=synthetic-proxy-1');
 const original=seen[0].socket;
 await request(proxy.port);assert.equal(seen.at(-1).socket,original,'completed replies return their socket to the pool');
 drop=true;
 assert.equal((await request(proxy.port,'/stale')).body,'ok');
 const stale=seen.filter(row=>row.url==='/stale');
 assert.equal(stale.length,2);assert.equal(stale[0].socket,original);assert.notEqual(stale[1].socket,original,'retry uses a fresh connection');
 // A fresh failure must not be retried, even though reads are safe.
 alwaysDrop=true;
 const beforeFresh=seen.length;
 assert.equal((await request(proxy.port,'/down')).status,404);assert.equal(seen.length-beforeFresh,1);
 alwaysDrop=false;
 await request(proxy.port,'/warm');const beforePost=accepts;
 drop=true;
 assert.equal((await request(proxy.port,'/write',{method:'POST',body:'must arrive once',headers:{'content-length':'16'}})).status,404);
 assert.equal(seen.filter(row=>row.url==='/write').length,1);assert.equal(accepts,beforePost,'POST failure opens no retry connection');
 await request(proxy.port,'/warm');drop=true;
 assert.equal((await request(proxy.port,'/read-body',{body:'x',headers:{'content-length':'1'}})).status,404);
 assert.equal(seen.filter(row=>row.url==='/read-body').length,1,'a streamed GET body is not replayed either');
 assert.equal((await request(proxy.port,'/echo',{method:'POST',body:'streamed bytes'})).body,'streamed bytes');
 assert.equal((await request(proxy.port,'/restricted')).status,404);
 assert.equal((await request(proxy.port,'/forbidden')).body,'application denial');
 assert.equal((await request(proxy.port,'/@fs/private')).status,404);
 const stream=http.get({host:'127.0.0.1',port:proxy.port,path:'/stream',headers:{connection:'keep-alive'},agent:false});
 const [reply]=await once(stream,'response');const [chunk]=await once(reply,'data');
 assert.equal(chunk.toString(),'first','a response streams before the upstream ends it');
 const ended=once(reply,'end');release();reply.resume();await ended;
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(begins,finishes,'each request finishes activity exactly once, including retry and failure');
 await proxy.close();
 // Every live upstream connection closes when the proxy does; no pool timer
 // or socket survives its listener. Wait on transport close, not a sleep.
 await Promise.all([...sockets].map(socket=>once(socket,'close')));
 assert.equal(sockets.size,0);
 t.diagnostic(`accepts=${accepts}; stale GET attempts=${stale.length}; POST attempts=1; activity=${begins}/${finishes}; upstream sockets after close=${sockets.size}`);
});
