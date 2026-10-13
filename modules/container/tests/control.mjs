import { request } from 'node:http';
let body='';for await(const chunk of process.stdin)body+=chunk;
const input=JSON.parse(body),timeout=['export','import'].includes(input.operation)?600000:60000;
const result=await new Promise((resolve,reject)=>{
 const outgoing=request('http://127.0.0.1:8081/',{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},response=>{
  let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.once('error',reject);response.once('end',()=>response.statusCode===200?resolve(text):reject(Error(text)));
 });
 outgoing.setTimeout(timeout,()=>outgoing.destroy(Error('Diagnostic transfer timed out')));outgoing.once('error',reject);outgoing.end(body);
});
console.log(result);
