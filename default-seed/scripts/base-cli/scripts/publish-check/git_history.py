"""Repository plumbing delegated to the installed Git, never decoded in Python."""
import os
from pathlib import Path
import subprocess
import tempfile
from public_base import parse, display, PublicBaseError


class InspectionError(Exception):
    def __init__(self, reason, diagnostic=None):
        super().__init__(reason)
        self.diagnostic = diagnostic


def git_failure(reason, command, *, exit_code=None, timeout=None, start_error=None, stderr=b''):
    if isinstance(stderr, bytes):
        stderr = stderr.decode('utf-8', 'replace')
    diagnostic = dict(command=command, stderr=(stderr or '').splitlines()[0] if stderr else '')
    if exit_code is not None:
        diagnostic['exitCode'] = exit_code
    if timeout is not None:
        diagnostic['timeoutSeconds'] = timeout
    if start_error is not None:
        diagnostic['startError'] = type(start_error).__name__ + ': ' + str(start_error)
    return InspectionError(reason, diagnostic)


def git_environment():
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1')
    return env


class History:
    def __init__(self, repo, ref='HEAD', public_base=None):
        self.repo = str(Path(repo).resolve())
        self.env = git_environment()
        self.public_commit = self.public_label = None
        self.public_tags = set()
        self.reader = None
        self.commit = self.run('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip()
        if self.run('rev-parse', '--is-shallow-repository').strip() != b'false':
            raise InspectionError('history.shallow')
        if public_base is not None:
            url, branch = parse(public_base, self.repo)
            try:
                self.run('fetch', '--quiet', '--prune', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--',
                         url, 'refs/heads/' + branch + ':refs/publish-check/public/base',
                         'refs/tags/*:refs/publish-check/public/tags/*')
                self.public_commit = self.run('rev-parse', 'refs/publish-check/public/base^{commit}').decode().strip()
                self.public_label = display(url) + '#' + branch
                self.public_tags = set(self.run('for-each-ref', '--format=%(objectname)',
                                               'refs/publish-check/public/tags').decode().splitlines())
            except InspectionError as error:
                rejected = PublicBaseError('public-base.fetch-failed')
                rejected.diagnostic = error.diagnostic
                raise rejected from None
        public_revisions = [self.public_commit, *sorted(self.public_tags)] if public_base else []
        self.revisions = [self.commit, *public_revisions] if public_base else ['--all', self.commit]
        self.commits = self.run('rev-list', *self.revisions).decode().splitlines()
        self.public_commits = set(self.run('rev-list', *public_revisions).decode().splitlines()) if public_base else set()
        self.trees = {}
        self.tree_ids = dict(line.split() for line in self.run('log', '--format=%H %T', *self.revisions).decode().splitlines())
        self.reader_command = ['git', '-C', self.repo, 'cat-file', '--batch']
        self.reader_errors = tempfile.TemporaryFile()
        try:
            self.reader = subprocess.Popen(self.reader_command, env=self.env, stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=self.reader_errors)
        except OSError as error:
            self.reader_errors.close()
            raise git_failure('history.git-unavailable', self.reader_command, start_error=error) from None

    def run(self, *args):
        command = ['git', '-C', self.repo, '-c', 'core.quotePath=false', *args]
        try:
            result = subprocess.run(command, env=self.env, capture_output=True, timeout=120)
            if result.returncode:
                raise git_failure('history.git-failed', command, exit_code=result.returncode, stderr=result.stderr)
            return result.stdout
        except subprocess.TimeoutExpired as error:
            raise git_failure('history.git-unavailable', command, timeout=error.timeout, stderr=error.stderr) from None
        except OSError as error:
            raise git_failure('history.git-unavailable', command, start_error=error) from None

    def reader_failure(self):
        timeout = None
        try:
            code = self.reader.wait(timeout=2)
        except subprocess.TimeoutExpired:
            code, timeout = None, 2
        self.reader_errors.seek(0)
        return git_failure('history.git-unavailable' if timeout else 'history.git-failed',
                           self.reader_command, exit_code=code, timeout=timeout,
                           stderr=self.reader_errors.readline())

    def commit_tree(self, commit):
        known = getattr(self, 'tree_ids', {}).get(commit)
        return known.encode() if known else self.run('rev-parse', commit + '^{tree}').strip()

    def entries(self, commit, recursive=True):
        tree = self.commit_tree(commit).decode()
        key = (tree, recursive)
        if key not in self.trees:
            args = ['ls-tree', '-z', '-l'] + (['-r'] if recursive else []) + [tree]
            entries = []
            for record in self.run(*args).split(b'\0'):
                if not record:
                    continue
                metadata, path = record.split(b'\t', 1)
                mode, kind, oid, size = metadata.split()
                entries.append(dict(path=os.fsdecode(path), mode=mode.decode(), kind=kind.decode(),
                                    oid=oid.decode(), size=int(size) if size != b'-' else 0))
            self.trees[key] = entries
        return self.trees[key]

    def root_entries(self, commit):
        return self.entries(commit, False)

    def blob(self, oid):
        if not oid or any(c not in '0123456789abcdef' for c in oid):
            raise InspectionError('history.invalid-object')
        try:
            self.reader.stdin.write(oid.encode() + b'\n')
            self.reader.stdin.flush()
        except BrokenPipeError:
            raise self.reader_failure() from None
        raw_header = self.reader.stdout.readline()
        if not raw_header:
            raise self.reader_failure()
        header = raw_header.split()
        if len(header) != 3 or header[1] != b'blob':
            raise InspectionError('history.missing-blob')
        size = int(header[2])
        data = self.reader.stdout.read(size)
        if len(data) != size or self.reader.stdout.read(1) != b'\n':
            raise self.reader_failure()
        return data

    def selected(self, path):
        entry = next((e for e in self.entries(self.commit) if e['path'] == path), None)
        return self.blob(entry['oid']) if entry and entry['kind'] == 'blob' else None

    def messages(self):
        records = self.run('log', '-z', '--format=%H%x00%B', *self.revisions).split(b'\0')
        for index in range(0, len(records) - 1, 2):
            if records[index]:
                yield 'commit', records[index].decode().strip(), records[index + 1]
        seen = set()
        for record in self.run('for-each-ref', '--format=%(objecttype) %(objectname)', 'refs/tags',
                               'refs/publish-check/public/tags').splitlines():
            kind, oid = record.decode().split()
            if kind == 'tag' and oid not in seen:
                seen.add(oid)
                raw = self.run('cat-file', 'tag', oid)
                yield 'tag', oid, raw.partition(b'\n\n')[2]

    def close(self):
        if self.reader:
            try:
                self.reader.stdin.close()
            except BrokenPipeError:
                pass
            self.reader.stdout.close()
            try:
                self.reader.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.reader.kill()
                self.reader.wait()
            self.reader_errors.close()
            self.reader = None
