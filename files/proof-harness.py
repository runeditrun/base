import concurrent.futures
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

repo = Path.cwd()
packet = repo.parent / 'packet'
root = Path(tempfile.mkdtemp(prefix='asset-retry-proof-'))
real_curl = shutil.which('curl')
results = {}
lock = threading.Lock()

def save():
    with lock:
        (packet / 'asset-retry-receipt.json').write_text(json.dumps(results, indent=2) + '\n')

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        key, name = self.path.strip('/').split('/', 1)
        with lock:
            counts[key] = counts.get(key, 0) + 1
            attempt = counts[key]
        code = 504 if key.endswith('failure') else (503 if attempt <= 2 else 200)
        self.send_response(code)
        self.end_headers()
        self.wfile.write(archives[name].read_bytes() if code == 200 else b'temporary failure\n')
    def log_message(self, *args):
        pass

archives = {}
for tool, owner, version, platform in [('actionlint', 'rhysd/actionlint', '1.7.7', 'linux_amd64'), ('gitleaks', 'gitleaks/gitleaks', '8.30.1', 'linux_x64')]:
    name = f'{tool}_{version}_{platform}.tar.gz'
    path = root / name
    url = f'https://github.com/{owner}/releases/download/v{version}/{name}'
    result = subprocess.run([real_curl, '--fail', '--silent', '--show-error', '--location', '--retry', '5', '--retry-all-errors', '--retry-delay', '5', '--retry-max-time', '600', '--max-time', '60', url, '-o', str(path)], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'fixture acquisition {name}: exit={result.returncode} {result.stderr}')
    archives[name] = path

counts = {}
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
shim = root / 'shim'
shim.mkdir()
(shim / 'curl').write_text('''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
original = args[:]
for index, arg in enumerate(args):
    if arg.startswith('https://github.com/'):
        args[index] = os.environ['FAKE_URL'] + '/' + arg.rsplit('/', 1)[-1]
    if arg == '=https':
        args[index] = '=http'
Path(os.environ['INVOCATION_FILE']).write_text(json.dumps({'original': original, 'local_transport': args}, indent=2) + '\\n')
raise SystemExit(subprocess.run([os.environ['REAL_CURL'], *args]).returncode)
''')
(shim / 'curl').chmod(0o755)
results['method'] = 'Unmodified product scripts via PATH curl transport shim: only pinned GitHub URL and HTTPS-only protocol switches redirect to local HTTP. Real curl, production retry budgets, real pinned archives/checksum/extraction/install. No shortened budget or product overrides.'
results['scratch'] = str(root)
save()

def check(tool, case):
    key = f'{tool}-{case}'
    destination = root / key / 'bin'
    invocation = packet / f'{key}-curl.json'
    env = dict(os.environ, PATH=str(shim) + os.pathsep + os.environ['PATH'], REAL_CURL=real_curl, FAKE_URL=f'http://127.0.0.1:{server.server_port}/{key}', INVOCATION_FILE=str(invocation))
    env[f'{tool.upper()}_INSTALL_DIR'] = str(destination)
    start = time.monotonic()
    result = subprocess.run(['bash', f'scripts/install-{tool}.sh'], env=env, capture_output=True, text=True, timeout=720)
    elapsed = time.monotonic() - start
    row = dict(exit_code=result.returncode, elapsed_seconds=round(elapsed, 3), requests=counts.get(key, 0), stdout=result.stdout, stderr=result.stderr, installed=(destination / tool).is_file(), invocation_file=invocation.name)
    if case == 'success':
        row['passed'] = result.returncode == 0 and row['requests'] == 3 and row['installed']
        if row['passed']:
            version = subprocess.run([str(destination / tool), '--version' if tool == 'gitleaks' else '-version'], capture_output=True, text=True)
            row['version_output'] = version.stdout + version.stderr
            shared_bin = root / 'bin'
            shared_bin.mkdir(exist_ok=True)
            shutil.copy2(destination / tool, shared_bin / tool)
    else:
        archive = next(name for name in archives if name.startswith(tool + '_'))
        row['passed'] = result.returncode == 22 and not row['installed'] and 'last HTTP status: 504; curl exit: 22' in result.stderr and archive in result.stderr and 590 <= elapsed <= 670
    with lock:
        results[key] = row
    save()
    print(key, json.dumps({k:v for k,v in row.items() if k not in ('stderr','stdout')}), flush=True)

try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(check, tool, case) for tool in ('actionlint', 'gitleaks') for case in ('success', 'failure')]
        for future in concurrent.futures.as_completed(futures):
            future.result()
finally:
    server.shutdown()
save()
raise SystemExit(0 if all(results[f'{tool}-{case}']['passed'] for tool in ('actionlint','gitleaks') for case in ('success','failure')) else 1)
