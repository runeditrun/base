"""Bounded reads of pinned Base preimages; ledger input never selects a remote."""
import os
import subprocess
import tempfile
from copy_identities import relative_path
from git_history import git_environment
from json_identity import GIT_REVISION

BASE = 'https://github.com/runeditrun/base.git'


class CopyOrigins:
    def __init__(self):
        self.temporary = None
        self.trees, self.files = {}, {}
        self.env = git_environment()

    def run(self, *args):
        result = subprocess.run(['git', '-C', self.temporary.name, *args], env=self.env,
                                capture_output=True, timeout=30)
        if result.returncode:
            raise ValueError('Unproved Base origin')
        return result.stdout

    def read(self, revision, path):
        if (not isinstance(revision, str) or not GIT_REVISION.fullmatch(revision)
                or not relative_path(path)):
            return None
        key = (revision, path)
        if key in self.files:
            return self.files[key]
        if len(self.files) >= 4096 or (revision not in self.trees and len(self.trees) >= 32):
            return None
        self.files[key] = None
        try:
            if self.temporary is None:
                self.temporary = tempfile.TemporaryDirectory(prefix='publish-copy-origin-')
                self.run('init', '--bare', '--quiet')
            if revision not in self.trees:
                # Cache refusals too: one unreachable pin never causes retries.
                self.trees[revision] = {}
                self.run('fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules',
                         '--no-auto-maintenance', '--no-write-fetch-head', '--', BASE, revision)
                if self.run('rev-parse', '--verify', revision + '^{commit}').strip().decode() != revision:
                    return None
                entries = {}
                for record in self.run('ls-tree', '-rz', '--full-tree', revision).split(b'\0'):
                    if record:
                        metadata, name = record.split(b'\t', 1)
                        mode, kind, oid = metadata.split()
                        if kind == b'blob' and mode in (b'100644', b'100755'):
                            entries[os.fsdecode(name)] = (oid.decode(), mode.decode())
                self.trees[revision] = entries
            entry = self.trees[revision].get(path)
            if entry:
                self.files[key] = (self.run('cat-file', 'blob', entry[0]), entry[1])
        except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
            pass
        return self.files[key]

    def close(self):
        if self.temporary:
            self.temporary.cleanup()
            self.temporary = None
