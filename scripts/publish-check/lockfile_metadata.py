"""Exact dependency metadata scalar spans; parser failure keeps email findings."""
from functools import lru_cache
import json
from pathlib import Path
import subprocess

PARSER = Path(__file__).with_suffix('.mjs')
LOCKFILES = {'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'}


@lru_cache(maxsize=32)
def without_package_contacts(data, filename):
    if filename not in LOCKFILES:
        return data
    try:
        data.decode('utf-8')
        result = subprocess.run(['node', str(PARSER), filename], input=data, capture_output=True, timeout=10)
        if result.returncode:
            return data
        spans = json.loads(result.stdout)
        if any(not isinstance(a, int) or not isinstance(b, int) or not 0 <= a <= b <= len(data) for a, b in spans):
            return data
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        return data
    output, offset = [], 0
    for start, end in sorted(spans):
        output.extend((data[offset:start], b' '))
        offset = max(offset, end)
    output.append(data[offset:])
    return b''.join(output)
