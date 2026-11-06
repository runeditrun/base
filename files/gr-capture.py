import datetime, hashlib, json, os, pathlib, subprocess, sys, time
root = pathlib.Path.home() / 'rer-consolidation/work/gr-publish-progress-reference-triage-1'
label, *command = sys.argv[1:]
packet = root / 'packet'
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
clock = time.monotonic()
with (packet / (label + '.stdout.log')).open('wb') as out, (packet / (label + '.stderr.log')).open('wb') as err:
    child = subprocess.Popen(command, stdout=out, stderr=err)
    receipt = dict(label=label, pid=child.pid, command=command, cwd=os.getcwd(), started_utc=started)
    (packet / (label + '.running.json')).write_text(json.dumps(receipt, indent=2) + '\n')
    code = child.wait()
receipt.update(exit_code=code, duration_seconds=time.monotonic() - clock, ended_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip())
receipt['outputs'] = {suffix: dict(bytes=(packet / (label + suffix)).stat().st_size, sha256=hashlib.sha256((packet / (label + suffix)).read_bytes()).hexdigest()) for suffix in ['.stdout.log', '.stderr.log']}
(packet / (label + '.receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n')
(packet / (label + '.running.json')).unlink()
print(json.dumps(receipt, indent=2), flush=True)
sys.exit(code)
