"""Publication inspection hydrates missing history from a real partial clone."""
import json
from pathlib import Path
import secrets
import shutil
import sys
import subprocess
import tempfile
import unittest

from history_scan import scan
from test_repo import RepositoryFixture, resolving


class PartialCloneTests(RepositoryFixture, unittest.TestCase):
    def test_deleted_blobs_are_hydrated_together_and_inspected(self):
        path = 'removed/settings.txt'
        credential = 'ghp_' + secrets.token_hex(20)
        self.write(path, credential)
        # Several absent blobs distinguish bulk hydration from per-blob fetching.
        for index in range(4):
            self.write(f'removed/note-{index}.txt', f'Historical note {index}.\n')
        historical_commit = self.commit()
        historical_blob = self.git('rev-parse', historical_commit + ':' + path)
        self.git('rm', '-qr', 'removed')
        self.commit()
        commits = int(self.git('rev-list', '--all', '--count'))
        self.git('config', 'uploadpack.allowFilter', 'true')
        self.git('config', 'uploadpack.allowAnySHA1InWant', 'true')

        with tempfile.TemporaryDirectory(prefix='publish-partial-') as temporary:
            directory = str(Path(temporary) / 'clone')
            subprocess.run(['git', 'clone', '-q', '--filter=blob:none',
                            self.repo.as_uri(), directory], check=True,
                           capture_output=True, timeout=30)

            def clone_git(*args):
                return subprocess.check_output(['git', '-C', directory, *args],
                                               stderr=subprocess.DEVNULL,
                                               timeout=30).decode().strip()

            def missing_objects():
                objects = clone_git('rev-list', '--objects', '--all', '--missing=print')
                return {line[1:] for line in objects.splitlines() if line.startswith('?')}

            self.assertEqual(clone_git('rev-parse', '--is-shallow-repository'), 'false')
            self.assertEqual(int(clone_git('rev-list', '--all', '--count')), commits)
            self.assertFalse((Path(directory) / path).exists())
            missing_before = missing_objects()
            self.assertIn(historical_blob, missing_before)
            self.assertGreater(len(missing_before), 1)

            # Count real remote sessions, including any accidental lazy fetch.
            requests = Path(temporary) / 'requests'
            transport = Path(temporary) / 'upload-pack'
            native = shutil.which('git-upload-pack')
            transport.write_text(f'#!{sys.executable}\nimport os, sys\n'
                                 f'with open({str(requests)!r}, "a") as log: log.write("fetch\\n")\n'
                                 f'os.execv({native!r}, [{native!r}, *sys.argv[1:]])\n')
            transport.chmod(0o755)
            clone_git('config', 'remote.origin.uploadpack', str(transport))

            with resolving('public'):
                report = scan(directory)

            # FAIL is a completed inspection of the deleted credential, rather
            # than an incomplete scan or a clean verdict from current files only.
            self.assertEqual(report['status'], 'FAIL')
            self.assertTrue(report['complete'])
            self.assertTrue(report['guarantees']['historyScanned'])
            self.assertEqual(report['history']['commits'], commits)
            self.assertTrue(any(f['rule'] == 'secret.provider-token'
                                and f['path'] == path
                                and historical_commit in f['commits']
                                and f.get('blob') == historical_blob
                                for f in report['findings']))
            hydration = report['history']['hydration']
            self.assertEqual(hydration['missingBefore'], len(missing_before))
            self.assertEqual(hydration['missingAfter'], 0)
            self.assertEqual(hydration['fetches'], 1)
            self.assertEqual(requests.read_text().splitlines(), ['fetch'])
            self.assertIsInstance(hydration['seconds'], float)
            self.assertGreaterEqual(hydration['seconds'], 0)
            self.assertEqual(missing_objects(), set())
            self.assertNotIn(credential, json.dumps(report))


if __name__ == '__main__':
    unittest.main()
