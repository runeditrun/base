import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--phase', choices=['before', 'after'], required=True)
parser.add_argument('--points', required=True)
args = parser.parse_args()
source = args.source.resolve()
packet = Path(__file__).parent / 'packet'
sys.path.insert(0, str(source / 'scripts/publish-check'))
from test_repo import RepositoryFixture, generic_credential

os.environ['PATH'] = str(Path.home() / '.local/bin') + ':' + os.environ['PATH']
for role in ('AUTHOR', 'COMMITTER'):
    os.environ['GIT_' + role + '_NAME'] = 'Run Edit Run fleet'
    os.environ['GIT_' + role + '_EMAIL'] = 'fleet@runeditrun.com'

def git(*argv):
    return subprocess.check_output(['git', '-C', str(source), *argv], text=True).strip()

provenance = dict(head=git('rev-parse', 'HEAD'), tree=git('rev-parse', 'HEAD^{tree}'),
                  clean=not bool(git('status', '--porcelain')))
rows = []
values = []

@contextmanager
def repo():
    fixture = RepositoryFixture()
    fixture.setUp()
    try:
        yield fixture
    finally:
        fixture.tearDown()

def credential():
    value = generic_credential()
    values.append(value)
    return value

def door(fixture, label, extra=(), portable=False):
    entry = source / ('default-seed/scripts/base-cli/scripts/publish-check.mjs' if portable else 'scripts/publish-check.mjs')
    argv = ['node', str(entry), '--repo', str(fixture.repo), *extra]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    assert not any(value in result.stdout + result.stderr for value in values), 'value-free output'
    report = json.loads(result.stdout)
    target = packet / (args.phase + '-' + label + '.json')
    target.write_text(json.dumps(report, indent=2) + '\n')
    row = dict(label=label, source=provenance, argv=argv, exit=result.returncode,
               status=report['status'], complete=report['complete'], report=target.name,
               sec3=[dict(bucket=bucket, path=f['path'], line=f['line'], scopes=f['scopes'])
                     for bucket in ('findings', 'preExisting') for f in report[bucket] if f['rule'] == 'SEC-3'])
    rows.append(row)
    return report, row

def locations(report, bucket='findings'):
    return {(f['path'], f['line']) for f in report[bucket] if f['rule'] == 'SEC-3'}

try:
    with repo() as fixture:
        expected = set()
        excluded = set()
        def write(path, text, value, positive=True):
            fixture.write(path, text)
            line = text[:text.index(value)].count('\n') + 1
            (expected if positive else excluded).add((path, line))
        value = credential()
        write('second.mjs', "export const config = { harmless: true, apiKey: '" + value + "' };\n", value)
        value = credential()
        write('second.ts', "const config = { harmless: true, client_secret: '" + value + "' };\n", value)
        value = credential()
        write('nested.mjs', "const config = { nested: {\n harmless: true,\n count: 2,\n // a later member\n token: '" + value + "'\n} };\n", value)
        value = credential()
        write('quoted.json', json.dumps(dict(harmless=True, apiKey=value)) + '\n', value)
        value = credential()
        write('first.mjs', "const config = { apiKey: '" + value + "', harmless: true };\n", value)
        value = credential()
        write('assignment.mjs', "const API_KEY = '" + value + "';\n", value)
        for label, template in (
            ('function-first', 'function f(apiKey: VALUE, harmless: string) {}'),
            ('function-later', 'function f(harmless: string, apiKey: VALUE) {}'),
            ('arrow-first', 'const f = (apiKey: VALUE, harmless: string) => {};'),
            ('arrow-later', 'const f = (harmless: string, apiKey: VALUE) => {};'),
            ('method', 'class Service { f(harmless: string, apiKey: VALUE) {} }'),
            ('interface', 'interface Options { harmless: string; apiKey: VALUE; }'),
            ('alias', 'type Options = { harmless: string; apiKey: VALUE; };')):
            value = credential()
            write(label + '.ts', template.replace('VALUE', "'" + value + "'") + '\n', value, False)
        value = credential()
        write('default.ts', "function f(harmless: string, apiKey = '" + value + "') {}\n", value)
        report, row = door(fixture, 'objects-and-annotations')
        got = locations(report)
        assert report['complete'] and row['exit'] == 1 and report['status'] == 'FAIL'
        assert not got & excluded, 'annotations remain excluded'
        assert any(f['rule'] == 'secret.assignment' for f in report['findings']), 'independent native finding'
        if args.phase == 'before':
            assert ('second.mjs', 1) not in got, 'incumbent must miss the later key'
            row['assertion'] = 'PASS: later bare object key lacks SEC-3 despite native FAIL'
        else:
            assert expected <= got, 'every positive location must be SEC-3'
            row['assertion'] = 'PASS: all object/default locations found; all type locations excluded'
            # One generated-copy public-door reproduction, using the same fixture.
            portable_report, portable_row = door(fixture, 'portable-object', portable=True)
            assert ('second.mjs', 1) in locations(portable_report)
            portable_row['assertion'] = 'PASS: generated scanner reports second.mjs:1 as SEC-3'
        row['expectedPositive'] = sorted(expected)
        row['expectedExcluded'] = sorted(excluded)

    if args.phase == 'after':
        for marker, expected in (('synthetic-', False), ('fixture-', True), ('test-', True), ('../modules/inbound-email/credentials', False)):
            with repo() as fixture:
                value = credential()
                literal = marker + value if marker.endswith('-') else marker
                values.append(literal)
                fixture.write('settings.mjs', "const API_KEY = '" + literal + "';\n")
                label = marker.rstrip('-') if marker.endswith('-') else 'reference'
                report, row = door(fixture, 'marker-' + label)
                assert report['complete']
                assert (('settings.mjs', 1) in locations(report)) == expected
                assert row['exit'] == (1 if expected else 0)
                assert report['status'] == ('FAIL' if expected else 'PASS')
                row['assertion'] = 'PASS'
        with repo() as fixture:
            value = credential()
            fixture.write('settings.mjs', "const config = { harmless: true, apiKey: '" + value + "' };\n")
            old = fixture.commit()
            (fixture.repo / 'settings.mjs').unlink()
            fixture.commit()
            report, row = door(fixture, 'deleted-history')
            assert row['exit'] == 1 and report['complete']
            assert any(f['rule'] == 'SEC-3' and f['path'] == 'settings.mjs' and old in f['commits'] for f in report['findings'])
            row['assertion'] = 'PASS: deleted second-key credential remains blocking history'
        with repo() as fixture, tempfile.TemporaryDirectory(prefix='sec3-public-') as temp:
            value = credential()
            text = "const config = { harmless: true, apiKey: '" + value + "' };\n"
            fixture.write('settings.mjs', text)
            old = fixture.commit()
            public = Path(temp) / 'public.git'
            fixture.git('clone', '-q', '--bare', str(fixture.repo), str(public))
            for name, entry in [('user.name', 'Run Edit Run fleet'), ('user.email', 'fleet@runeditrun.com')]:
                subprocess.run(['git', '-C', str(public), 'config', name, entry], check=True)
            fixture.write('README.md', 'A new descendant, with identical selected credential bytes.\n')
            fixture.commit()
            report, row = door(fixture, 'public-identical', ['--public-base', str(public) + '#main'])
            assert row['exit'] == 0 and report['complete'] and report['status'] == 'PASS'
            assert ('settings.mjs', 1) in locations(report, 'preExisting') and not locations(report)
            row['assertion'] = 'PASS: old public and identical selected/working bytes are preExisting'
            replacement = credential()
            fixture.write('settings.mjs', text.replace(value, replacement))
            fixture.commit()
            report, row = door(fixture, 'public-changed', ['--public-base', str(public) + '#main'])
            assert row['exit'] == 1 and report['complete']
            assert ('settings.mjs', 1) in locations(report) and ('settings.mjs', 1) in locations(report, 'preExisting')
            assert any(f['rule'] == 'SEC-3' and 'working-tree' in f['scopes'] for f in report['findings'])
            row['assertion'] = 'PASS: changed selected/working bytes block independently of old public ancestry'
        with repo() as fixture:
            value = credential()
            fixture.write('settings.mjs', "const config = { harmless: true, apiKey: '" + value + "' };\n")
            fixture.commit()
            blob = fixture.git('rev-parse', 'HEAD:settings.mjs')
            fixture.write('.publish-check/reviewed.json', json.dumps(dict(schemaVersion=1, findings=[dict(
                rule='SEC-3', path='settings.mjs', blob=blob, reason='Verified generated fixture',
                reviewer='Fixture reviewer', date='2026-11-06')])) + '\n')
            fixture.commit()
            report, row = door(fixture, 'review-rejected')
            assert row['exit'] == 2 and not report['complete'] and report['status'] == 'INCOMPLETE'
            assert any(f['rule'] == 'scan.configuration-incomplete' for f in report['findings'])
            row['assertion'] = 'PASS: exact SEC-3 review is rejected, never waived'
    summary = dict(phase=args.phase, points=args.points.split(','), source=provenance, assertion='PASS', commands=rows)
    (packet / (args.phase + '-matrix-receipt.json')).write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(dict(phase=args.phase, assertion='PASS', commands=len(rows), head=provenance['head'])))
except Exception as error:
    (packet / (args.phase + '-matrix-receipt.json')).write_text(json.dumps(dict(
        phase=args.phase, source=provenance, assertion='FAIL', errorType=type(error).__name__, commands=rows), indent=2) + '\n')
    print(json.dumps(dict(phase=args.phase, assertion='FAIL', errorType=type(error).__name__)))
    sys.exit(1)
