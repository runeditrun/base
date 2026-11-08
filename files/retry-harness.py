import http.server,ssl,threading,subprocess,os,json,time,sys
from pathlib import Path
root=Path('/tmp/fv-retry-proof')
packet=Path.home()/'rer-consolidation/work/fv-base-asset-retry-1-pc1/packet'
class Handler(http.server.BaseHTTPRequestHandler):
    counts={}
    mode='recover'
    def do_GET(self):
        name=self.path.rsplit('/',1)[-1]
        self.counts[name]=self.counts.get(name,0)+1
        status=504 if self.mode=='fail' else 503 if self.counts[name]<=2 else 200
        self.send_response(status)
        data=(root/'assets'/name).read_bytes() if status==200 else b'temporary release asset failure'
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        if status==200:self.wfile.write((root/'assets'/name).read_bytes())
        else:self.wfile.write(b'temporary release asset failure')
        with (packet/'http-requests.jsonl').open('a') as f:
            f.write(json.dumps(dict(asset=name,attempt=self.counts[name],status=status,time=time.time()))+'\n')
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(root/'cert.pem',root/'key.pem')
server.socket=ctx.wrap_socket(server.socket,server_side=True)
threading.Thread(target=server.serve_forever,daemon=True).start()
wrapper=root/'bin/curl'
wrapper.write_text('#!/bin/sh\nexec /usr/bin/curl --connect-to github.com:443:127.0.0.1:'+str(server.server_port)+' --cacert /tmp/fv-retry-proof/cert.pem --noproxy github.com "$@"\n')
wrapper.chmod(0o755)
env=dict(os.environ,PATH=str(root/'bin')+':'+os.environ['PATH'],ACTIONLINT_INSTALL_DIR=str(root/'installed'),GITLEAKS_INSTALL_DIR=str(root/'installed'))
results=[]
for name in ('actionlint','gitleaks'):
    start=time.monotonic()
    r=subprocess.run(['bash','scripts/install-'+name+'.sh'],env=env,capture_output=True,text=True)
    row=dict(tool=name,scenario='503,503,200',exit=r.returncode,seconds=round(time.monotonic()-start,2),stdout=r.stdout,stderr=r.stderr,requests=Handler.counts.copy())
    results.append(row); print(json.dumps(row),flush=True)
    assert r.returncode==0 and Handler.counts[next(k for k in Handler.counts if k.startswith(name))]==3
Handler.counts={};Handler.mode='fail'
# No budget override exists: execute unchanged full-budget production script.
start=time.monotonic()
r=subprocess.run(['bash','scripts/install-actionlint.sh'],env=env,capture_output=True,text=True)
row=dict(tool='actionlint',scenario='always 504; production 600-second budget',exit=r.returncode,seconds=round(time.monotonic()-start,2),stdout=r.stdout,stderr=r.stderr,requests=Handler.counts.copy())
results.append(row);print(json.dumps(row),flush=True)
(packet/'retry-proof.json').write_text(json.dumps(results,indent=2)+'\n')
assert r.returncode==22 and 'last HTTP status: 504; curl exit: 22' in r.stderr
server.shutdown()
