"""Register SEC-3 with text inspection and value-free, line-aware reports."""
import atexit
from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
from git_history import InspectionError
from report import Findings as PublicationFindings
from tree_scan import text_rules as publication_text_rules


@dataclass(frozen=True)
class AssignmentFinding:
    line: int


class AssignmentScanner:
    def __init__(self):
        self.worker = None
        atexit.register(self.close)

    def findings(self, data, path):
        try:
            if self.worker is None:
                self.worker = subprocess.Popen(
                    ['node', str(Path(__file__).with_suffix('.mjs'))],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, encoding='utf-8')
            self.worker.stdin.write(json.dumps(dict(text=data.decode('utf-8', 'replace'), path=path)) + '\n')
            self.worker.stdin.flush()
            result = json.loads(self.worker.stdout.readline())
            if not isinstance(result, list) or any(not isinstance(hit.get('line'), int) or hit['line'] < 1 for hit in result):
                raise ValueError('invalid SEC-3 response')
            return {AssignmentFinding(hit['line']) for hit in result}
        except (OSError, ValueError, AttributeError, TypeError):
            raise InspectionError('scan.credential-assignment-incomplete') from None

    def close(self):
        if self.worker is not None:
            self.worker.stdin.close()
            self.worker.wait()
            self.worker.stdout.close()
            self.worker = None


scanner = AssignmentScanner()


def text_rules(data, path, config, env_hashes, *, commit_message=False):
    rules, provenance, references = publication_text_rules(data, path, config, env_hashes,
                                                         commit_message=commit_message)
    # Hosted source scanning covers archive files, not Git messages or path text.
    if path not in ('@commit-message', '@tag-message'):
        rules.update(scanner.findings(data, path))
    return rules, provenance, references


class Findings(PublicationFindings):
    def add(self, rule, path, commit=None, oid=None, scope='newly-public', bucket=None, scanner_rule=None):
        if not isinstance(rule, AssignmentFinding):
            return super().add(rule, path, commit, oid, scope, bucket, scanner_rule)
        bucket = bucket or ('preExisting' if scope == 'pre-existing' else 'findings')
        # The internal discriminator keeps separate lines separate while using
        # the existing history/scope deduplication and path redaction.
        discriminator = 'SEC-3:' + str(rule.line)
        super().add('SEC-3', path, commit, oid, scope, bucket, discriminator)
        item = self.seen[bucket, 'SEC-3', path, oid, discriminator]
        item['line'] = rule.line
        item.pop('scannerRule', None)
