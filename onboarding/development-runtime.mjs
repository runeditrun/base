import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Bind first, then announce the actual application listener over the private
// parent channel. No free-port probe is released before Vite binds.
const require=createRequire(join(process.cwd(),'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const args=process.argv.slice(2),port=Number(args[args.indexOf('--port')+1]);
const server=await createServer({server:{host:'127.0.0.1',port,strictPort:true}});
let stopping;
const stop=()=>stopping??=server.close().finally(()=>process.disconnect?.());
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
try {
 await server.listen();
 const actual=server.httpServer.address().port;
 process.send?.({type:'rer-listening',requestedPort:port,port:actual});
 server.printUrls();
}catch(error){await stop();throw error;}
