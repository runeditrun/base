"""Public scanner observations at real Git, native process and OS edges."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from test_repo import ROOT, RepositoryFixture


class ProgressTests(RepositoryFixture, unittest.TestCase):
    def public(self, repo=None, *, env=None, args=()):
        return subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(repo or self.repo),
                               *args], capture_output=True, text=True, timeout=15, env=env)

    def isolated(self, directory):
        subprocess.run(['git', 'config', '--file', str(directory / '.gitconfig'),
                        '--add', 'safe.directory', str(ROOT)], check=True)
        return {**os.environ, 'HOME': str(directory), 'RER_SCAN_SLOTS': '1'}

    def delay(self, path, native, marker, *, version=False):
        # Delay an actual native entry, never substitute its answer. The child
        # also proves the scanner's process-group kill reaches descendants.
        path.write_text(f'#!{sys.executable}\nimport json, os, pathlib, subprocess, sys, time\n'
                        + (f'if sys.argv[1:] == ["version"]: os.execv({native!r}, [{native!r}, *sys.argv[1:]])\n'
                           if version else '') +
                        'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])\n'
                        f'pathlib.Path({str(marker)!r}).write_text(json.dumps([os.getpid(), child.pid, os.environ["TMPDIR"]]))\n'
                        'time.sleep(60)\n'
                        f'os.execv({native!r}, [{native!r}, *sys.argv[1:]])\n')
        path.chmod(0o755)

    def refused_deadline(self, result):
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report['status'], 'INCOMPLETE')
        self.assertFalse(report['complete'])
        self.assertFalse(report['guarantees']['historyScanned'])
        self.assertIsNone(report['source'])
        self.assertEqual(report['history'], dict(commits=0, trees=0, blobs=0))
        self.assertEqual([item['rule'] for item in report['findings']], ['scan.deadline-exceeded'])
        self.assertEqual(report['progress']['slot'], 'acquired')
        self.assertGreater(report['progress']['elapsedMs'], 0)
        self.assertEqual(result.stderr, '')
        return report['progress']['worker']

    def cleaned(self, marker):
        self.assertTrue(marker.exists(), 'real native process reached its delay')
        parent, child, scratch = json.loads(marker.read_text())
        self.assertFalse(Path(scratch).exists(), 'private scanner scratch is removed')
        for pid in (parent, child):
            # An unreaped orphan may briefly be a zombie; it cannot run or hold
            # the slot. Never signal a PID after the scanner has reaped it.
            end = time.monotonic() + 3
            while True:
                state = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
                if not state.stdout.strip() or state.stdout.strip().startswith('Z'):
                    break
                self.assertLess(time.monotonic(), end, 'native descendant survived scanner deadline')
                time.sleep(0.05)

    def test_hydration_deadline_and_resumed_clean_and_finding_scans(self):
        self.write('removed.txt', 'A historical note.\n')
        self.commit()
        self.git('rm', '-q', 'removed.txt')
        self.commit()
        self.git('tag', '-a', 'public-note', '-m', 'Public note')
        self.git('config', 'uploadpack.allowFilter', 'true')
        self.git('config', 'uploadpack.allowAnySHA1InWant', 'true')
        with tempfile.TemporaryDirectory(prefix='scan-progress-hydration-') as temporary:
            directory = Path(temporary)
            clone = directory / 'clone'
            subprocess.run(['git', 'clone', '-q', '--filter=blob:none', self.repo.as_uri(), str(clone)],
                           check=True, capture_output=True)
            missing = subprocess.check_output(['git', '-C', str(clone), 'rev-list', '--objects',
                                               '--all', '--missing=print']).splitlines()
            missing_count = sum(line.startswith(b'?') for line in missing)
            self.assertGreater(missing_count, 0)
            marker = directory / 'native'
            upload = directory / 'upload-pack'
            self.delay(upload, shutil.which('git-upload-pack'), marker)
            subprocess.run(['git', '-C', str(clone), 'config', 'remote.origin.uploadpack', str(upload)], check=True)
            env = self.isolated(directory)
            worker = self.refused_deadline(self.public(clone, env=env, args=('--timeout-seconds', '2')))
            self.assertEqual(worker['lastEnteredPhase'], 'hydration')
            self.assertEqual(worker['lastCompletedPhase'], 'preparation')
            self.assertEqual(worker['activeOperation'], 'git.fetch')
            self.assertEqual(worker['selectedRevisions'], 1)
            self.assertEqual(worker['publicRevisions'], 0)
            self.assertEqual(worker['hydration']['missingBefore'], missing_count)
            self.assertIsNone(worker['hydration']['missingAfter'])
            self.assertIsNone(worker['historyCommits'])
            self.assertIsNone(worker['publicCommits'])
            self.assertGreaterEqual(worker['observedElapsedMs'], 0)
            self.cleaned(marker)
            subprocess.run(['git', '-C', str(clone), 'config', '--unset', 'remote.origin.uploadpack'], check=True)
            clean = self.public(clone, env=env, args=('--public-base', self.repo.as_uri() + '#main'))
            self.assertEqual(clean.returncode, 0, clean.stderr + clean.stdout)
            report = json.loads(clean.stdout)
            self.assertEqual(report['status'], 'PASS')
            self.assertTrue(report['complete'])
            self.assertTrue(report['guarantees']['historyScanned'])
            self.assertEqual(report['history']['commits'], int(self.git('rev-list', '--all', '--count')))
            self.assertEqual(report['history']['hydration']['missingBefore'], missing_count)
            self.assertEqual(report['history']['hydration']['missingAfter'], 0)
            self.assertEqual(report['progress']['worker']['publicRevisions'], 2)
            self.assertEqual(report['progress']['worker']['historyCommits'], report['history']['commits'])
            self.assertEqual(report['progress']['worker']['publicCommits'], len(report['history']['preExistingCommits']))
            self.assertEqual(report['progress']['worker']['lastCompletedPhase'], 'references')
            # Same public door and slot after a deadline; inspect a real deleted
            # credential too, rather than only a clean current tree.
            value = 'ghp_' + secrets.token_hex(20)
            self.write('secret.txt', value)
            held = self.commit()
            self.git('rm', '-q', 'secret.txt')
            self.commit()
            finding = self.public(env=env)
            self.assertEqual(finding.returncode, 1, finding.stderr + finding.stdout)
            report = json.loads(finding.stdout)
            self.assertTrue(report['complete'])
            self.assertTrue(report['guarantees']['historyScanned'])
            self.assertEqual(report['history']['commits'], int(self.git('rev-list', '--all', '--count')))
            self.assertTrue(any(item['rule'] == 'secret.provider-token' and held in item['commits']
                                for item in report['findings']))
            self.assertNotIn(value, finding.stdout + finding.stderr)

    def test_later_native_deadlines(self):
        for phase, binary, operation, completed in (
                ('preparation', 'gitleaks', 'gitleaks.version', None),
                ('gitleaks', 'gitleaks', 'gitleaks.git', 'history-text'),
                ('references', 'gh', 'gh.graphql', 'gitleaks')):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix='scan-progress-native-') as temporary:
                directory = Path(temporary)
                if phase == 'references':
                    self.write('README.md', 'Source: https://github.com/octocat/Hello-World\n')
                    self.commit()
                binaries = directory / 'bin'
                binaries.mkdir()
                marker = directory / 'native'
                self.delay(binaries / binary, shutil.which(binary), marker, version=phase == 'gitleaks')
                env = self.isolated(directory)
                env['PATH'] = str(binaries) + os.pathsep + env['PATH']
                worker = self.refused_deadline(self.public(env=env, args=('--timeout-seconds', '6')))
                self.assertEqual(worker['lastEnteredPhase'], phase)
                self.assertEqual(worker['lastCompletedPhase'], completed)
                self.assertEqual(worker['activeOperation'], operation)
                if phase == 'preparation':
                    self.assertIsNone(worker['selectedRevisions'])
                    self.assertIsNone(worker['publicRevisions'])
                    self.assertTrue(all(value is None for value in worker['hydration'].values()))
                else:
                    self.assertEqual(worker['hydration']['missingAfter'], 0)
                    self.assertEqual(worker['historyCommits'], int(self.git('rev-list', '--all', '--count')))
                self.cleaned(marker)

    def test_untrusted_progress_and_report_injection_are_unavailable(self):
        canary = 'synthetic-private-' + secrets.token_hex(16)
        corruptions = [
            f'value["lastEnteredPhase"] = {canary!r}',
            f'value["activeOperation"] = {canary!r}',
            f'value["hydration"]["path"] = {canary!r}',
            f'value["source"] = {canary!r}',
            'value["selectedRevisions"] = True',
            'value["selectedRevisions"] = 2**53',
            'value["hydration"]["missingBefore"] = -1',
            'del value["lastCompletedPhase"]',
            'value["hydration"] = []',
            'os.ftruncate(4, 2048); return',
            'os.ftruncate(4, 0); return',
            'os.pwrite(4, b"partial", 0); return',
        ]
        with tempfile.TemporaryDirectory(prefix='scan-progress-untrusted-') as temporary:
            directory = Path(temporary)
            env = self.isolated(directory)
            env['PYTHONPATH'] = str(directory)
            for corruption in corruptions:
                with self.subTest(corruption=corruption):
                    # The real worker produces an INCOMPLETE report for an
                    # invalid ref. Corrupt only its diagnostic transport and
                    # add an untrusted progress field to that actual report.
                    (directory / 'sitecustomize.py').write_text(
                        'import atexit, hashlib, json, os, pathlib, sys\n'
                        'if sys.argv[0].endswith("/cli.py"):\n'
                        ' def corrupt():\n'
                        '  report = pathlib.Path(os.environ["TMPDIR"], "report.json")\n'
                        '  document = json.loads(report.read_text())\n'
                        f'  document["progress"] = {{"path": {canary!r}}}\n'
                        '  report.write_text(json.dumps(document))\n'
                        '  value = json.loads(os.pread(4, 1024, 0)[65:])\n'
                        '  ' + corruption + '\n'
                        '  body = json.dumps(value).encode().ljust(959)\n'
                        '  os.pwrite(4, hashlib.sha256(body).hexdigest().encode() + b"\\n" + body, 0)\n'
                        ' atexit.register(corrupt)\n')
                    result = self.public(env=env, args=('--ref', 'refs/heads/absent'))
                    self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                    report = json.loads(result.stdout)
                    self.assertEqual(report['status'], 'INCOMPLETE')
                    self.assertFalse(report['complete'])
                    self.assertFalse(report['guarantees']['historyScanned'])
                    self.assertIsNone(report['source'])
                    self.assertEqual(report['findings'][0]['rule'], 'scan.history-incomplete')
                    self.assertIsNone(report['progress']['worker'])
                    self.assertNotIn(canary, result.stdout + result.stderr)
            # An interrupted process may leave a partial frame and a partial
            # report. The real public deadline still owns the refusal.
            (directory / 'sitecustomize.py').write_text(
                'import os, sys, time\n'
                'if sys.argv[0].endswith("/cli.py"):\n'
                f' os.pwrite(4, {canary.encode()!r}, 0)\n'
                ' time.sleep(60)\n')
            worker = self.refused_deadline(self.public(env=env, args=('--timeout-seconds', '0.3')))
            self.assertIsNone(worker)


if __name__ == '__main__':
    unittest.main()
