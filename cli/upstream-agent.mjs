import http from 'node:http';

// Expire only idle connections, well before Vite's 5 s keep-alive timeout.
// Active streams have no deadline imposed by the pool.
export class UpstreamAgent extends http.Agent {
 constructor(){super({keepAlive:true,maxSockets:16,maxFreeSockets:4});}
 keepSocketAlive(socket){
  if(!super.keepSocketAlive(socket))return false;
  socket.setTimeout(1000);
  return true;
 }
 reuseSocket(socket,request){socket.setTimeout(0);super.reuseSocket(socket,request);}
}
