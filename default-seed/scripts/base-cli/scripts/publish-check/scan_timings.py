"""Numeric scan costs and implementation identity, without source file values."""
import hashlib
import json
from pathlib import Path
import platform
from time import monotonic


def implementation():
    directory = Path(__file__).parent
    digest = hashlib.sha256()
    for path in sorted(directory.glob('*.py')):
        if path.name.startswith(('test', 'coverage_')):
            continue
        digest.update(path.name.encode() + b'\0' + path.read_bytes())
    root = directory.parent.parent
    for path, key in ((root / 'inventory.json', 'cliVersion'),
                      (root / 'package.json', 'version'), (root / 'global/package.json', 'version')):
        if path.is_file():
            version = json.loads(path.read_text()).get(key)
            if version:
                break
    else:
        version = None
    return dict(version=version, sha256=digest.hexdigest(), python=platform.python_version())


class Timings:
    def __init__(self, report):
        self.started = monotonic()
        self.values = report['timings'] = dict(totalSeconds=0, phases={})
        report['implementation'] = implementation()

    def call(self, name, function, *args, **kwargs):
        started = monotonic()
        try:
            return function(*args, **kwargs)
        finally:
            phase = self.values['phases'].setdefault(name, dict(calls=0, seconds=0))
            phase['calls'] += 1
            phase['seconds'] += monotonic() - started

    def finish(self):
        self.values['totalSeconds'] = round(monotonic() - self.started, 6)
        for phase in self.values['phases'].values():
            phase['seconds'] = round(phase['seconds'], 6)
