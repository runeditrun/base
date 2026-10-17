"""Real disposable Git repositories; only test suites contain synthetic values."""
from contextlib import contextmanager
import json
from pathlib import Path
import secrets
import subprocess
import tempfile
from unittest.mock import patch
from history_scan import scan

ROOT = Path(__file__).resolve().parents[2]
LICENSE = (ROOT / 'LICENSE').read_bytes()


def generic_credential():
    # Gitleaks ignores a generic match whose value contains an English stopword
    # (about 2% of random base64url strings). Letters here never touch, so no
    # word can occur, while length, digits and entropy stay credential-shaped.
    return ''.join(secrets.choice('BCDFGHJKLMNPQRSTVWXZ') + secrets.choice('0123456789') for _ in range(20))


@contextmanager
def resolving(state):
    """Answer the scan's bulk repository lookup with one verdict, or a verdict per repository.

    Yields the set of repositories the scan asked about.
    """
    asked = set()
    def resolve_all(resolver, repositories):
        asked.update(repositories)
        return {repository: state(repository) if callable(state) else state for repository in repositories}
    with patch('github_refs.GitHubResolver.resolve_all', resolve_all):
        yield asked


class RepositoryFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='publish-fixture-')
        self.repo = Path(self.temp.name)
        self.git('init', '-q', '-b', 'main')
        self.write('LICENSE', LICENSE)
        self.write('README.md', 'A clean fixture.')
        self.commit()

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), '-c', 'user.name=Fixture',
                                       '-c', 'user.email=fixture@example.invalid', *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, path, data):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data if isinstance(data, bytes) else data.encode())

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture', '--allow-empty')
        return self.git('rev-parse', 'HEAD')

    def report(self, **options):
        return scan(str(self.repo), 'HEAD', **options)

    def assert_fails(self, rule, path=None, **options):
        report = self.report(**options)
        self.assertEqual(report['status'], 'FAIL')
        self.assertTrue(any(f['rule'] == rule and (path is None or f['path'] == path) for f in report['findings']))
        return report
