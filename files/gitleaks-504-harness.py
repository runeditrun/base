import http.server,ssl,threading,subprocess,os,json,time
from pathlib import Path
root=Path('/tmp/fv-retry-proof')
packet=Path.home()/'rer-consolidation/work/fv-base-asset-retry-1-pc1/packet'
class Handler(http.server.BaseHTTPRequestHandler):
    count=0
    def do_GET(self):
        type(self).count+=1
        data=b'temporary release asset failure'
        self.send_response(504);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        with (packet/'gitleaks-504-requests.jsonl').open('a') as f:
            f.write(json.dumps(dict(asset=self.path.rsplit('/',1)[-1],attempt=type(self).count,status=504,time=time.time()))+'\n')
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(root/'cert.pem',root/'key.pem')
server.socket=ctx.wrap_socket(server.socket,server_side=True)
threading.Thread(target=server.serve_forever,daemon=True).start()
bin=root/'fail-bin';bin.mkdir(exist_ok=True)
wrapper=bin/'curl'
wrapper.write_text('#!/bin/sh\nexec /usr/bin/curl --connect-to github.com:443:127.0.0.1:'+str(server.server_port)+' --cacert /tmp/fv-retry-proof/cert.pem --noproxy github.com "$@"\n')
wrapper.chmod(0o755)
env=dict(os.environ,PATH=str(bin)+':'+os.environ['PATH'],GITLEAKS_INSTALL_DIR=str(root/'installed'))
start=time.monotonic()
r=subprocess.run(['bash','scripts/install-gitleaks.sh'],env=env,capture_output=True,text=True)
row=dict(tool='gitleaks',scenario='always 504; production 600-second budget',exit=r.returncode,seconds=round(time.monotonic()-start,2),stdout=r.stdout,stderr=r.stderr,requests=Handler.count)
(packet/'gitleaks-504-proof.json').write_text(json.dumps(row,indent=2)+'\n')
print(json.dumps(row),flush=True)
assert r.returncode==22 and 'last HTTP status: 504; curl exit: 22' in r.stderr
server.shutdown()
