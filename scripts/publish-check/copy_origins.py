"""Read exact copy preimages from pinned commits in public Base."""
import hashlib
import subprocess
import tempfile

from git_history import git_environment

BASE = 'https://github.com/runeditrun/base.git'


class CopyOrigins:
    def __init__(self):
        self.temporary = None
        self.revisions, self.files = {}, {}

    def run(self, *args):
        return subprocess.run(['git', '-C', self.temporary.name, *args], env=git_environment(),
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=30).stdout

    def fetch(self, revision):
        if self.temporary is None:
            self.temporary = tempfile.TemporaryDirectory(prefix='publish-copy-origin-')
            self.run('init', '--quiet', '--bare')
        self.run('fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules',
                 '--no-auto-maintenance', '--no-write-fetch-head', '--', BASE, revision)
        return self.run('rev-parse', '--verify', revision + '^{commit}').strip() == revision.encode('ascii')

    def read(self, revision, path):
        # Callers provide a validated full revision and repository-relative path.
        key = (revision, path)
        if key in self.files:
            return self.files[key]
        if len(self.files) >= 4096 or (revision not in self.revisions and len(self.revisions) >= 32):
            return None
        self.files[key] = None
        try:
            if revision not in self.revisions:
                self.revisions[revision] = False
                self.revisions[revision] = self.fetch(revision)
            if self.revisions[revision]:
                entry = self.run('--literal-pathspecs', 'ls-tree', '-z', '--full-tree', revision, '--', path)
                metadata, separator, name = entry.partition(b'\t')
                if separator and name == path.encode('utf-8') + b'\0':
                    mode, kind, oid = metadata.split()
                    if kind == b'blob' and mode in (b'100644', b'100755'):
                        self.files[key] = (hashlib.sha256(self.run('cat-file', 'blob', oid.decode())).hexdigest(), mode.decode())
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        return self.files[key]

    def close(self):
        if self.temporary is not None:
            self.temporary.cleanup()
