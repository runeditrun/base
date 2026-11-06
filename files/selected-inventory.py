import json
from pathlib import Path
import subprocess

root = Path(__file__).parent
source = root / 'base'
def git(*argv):
    return subprocess.check_output(['git', '-C', str(source), *argv])
workers = [subprocess.Popen(['node', str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
           for path in (root / 'baseline-worker/credential_assignments.mjs',
                        source / 'scripts/publish-check/credential_assignments.mjs')]
rows = []
counts = [0, 0]
try:
    entries = git('ls-tree', '-rz', 'HEAD').split(b'\0')
    for entry in entries:
        if not entry:
            continue
        header, raw_path = entry.split(b'\t', 1)
        mode, kind, blob = header.split()
        if kind != b'blob' or mode not in (b'100644', b'100755'):
            continue
        path = raw_path.decode()
        text = git('cat-file', 'blob', blob.decode()).decode('utf-8', 'replace')
        request = json.dumps(dict(text=text, path=path)) + '\n'
        results = []
        for i, worker in enumerate(workers):
            worker.stdin.write(request)
            worker.stdin.flush()
            findings = json.loads(worker.stdout.readline())
            assert isinstance(findings, list)
            results.append(findings)
            counts[i] += len(findings)
        before = {hit['line'] for hit in results[0]}
        for finding in results[1]:
            if finding['line'] not in before:
                # Preserve each location-only worker classification unchanged.
                rows.append(dict(path=path, rule='SEC-3', classification=finding))
finally:
    for worker in workers:
        worker.stdin.close()
        worker.wait()
        worker.stdout.close()
record = dict(target_head=git('rev-parse', 'HEAD').decode().strip(),
              target_tree=git('rev-parse', 'HEAD^{tree}').decode().strip(),
              scanner='candidate working source; selected tracked HEAD bytes only',
              baseline='incumbent worker copied before editing',
              before_count=counts[0], after_count=counts[1], newly_exposed=rows)
(root / 'packet/selected-tree-sec3-inventory.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record, indent=2))
