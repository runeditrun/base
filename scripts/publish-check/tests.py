"""One real-repository fixture for each retained history/secret requirement."""
import hashlib
import json
import os
import secrets
import struct
import subprocess
import tempfile
import unittest
import zlib
from test_repo import ROOT, RepositoryFixture, resolving, generic_credential
from history_scan import scan
from test_partial_clone import PartialCloneTests
from test_copy_digests import CopyDigestTests


class HistoryTests(RepositoryFixture, unittest.TestCase):
    def test_clean(self):
        report = self.report()
        self.assertEqual(report['status'], 'PASS')
        self.assertTrue(report['complete'])
        self.assertTrue(report['guarantees']['historyScanned'])

    def test_deleted_secret(self):
        value = 'ghp_' + secrets.token_hex(20)
        self.write('settings.txt', value)
        first = self.commit()
        (self.repo / 'settings.txt').unlink()
        self.commit()
        report = self.assert_fails('secret.provider-token', 'settings.txt')
        self.assertEqual(report['findings'][0]['commit'], first)
        self.assertNotIn(value, json.dumps(report))

    def test_working_tree_including_ignored_files(self):
        self.write('.gitignore', '.env\n')
        self.commit()
        value = 'ghp_' + secrets.token_hex(20)
        self.write('.env', 'TOKEN=' + value)
        report = self.assert_fails('secret.provider-token', '.env')
        self.assertTrue(any(f['scope'] == 'working-tree' for f in report['findings']))
        self.assertNotIn(value, json.dumps(report))

    def test_other_branch(self):
        self.git('checkout', '-qb', 'other')
        self.write('hidden.txt', 'ghp_' + secrets.token_hex(20))
        self.commit()
        self.git('checkout', '-q', 'main')
        self.assert_fails('secret.provider-token', 'hidden.txt')

    def test_assignment(self):
        self.write('settings.ts', "const apiKey = '" + generic_credential() + "';")
        self.commit()
        self.assert_fails('secret.assignment', 'settings.ts')

    def test_hosted_credential_assignment_through_cli(self):
        value = generic_credential()
        backlog_fixture = 'cron-' + 'backlog-fixture-' + 'signing-token'
        cases = [('settings.ts', literal) for literal in
                 ('synthetic-' + value, '../modules/inbound-email/credentials', value, backlog_fixture)]
        cases.extend((path, value) for path in ('@commit-message', '@tag-message'))
        for path, literal in cases:
            for previous in ('settings.ts', '@commit-message', '@tag-message'):
                (self.repo / previous).unlink(missing_ok=True)
            self.write(path, "// configuration\nconst INBOUND_EMAIL_TOKEN = '" + literal + "';\n")
            result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo)],
                                    capture_output=True, text=True, timeout=120)
            report = json.loads(result.stdout)
            self.assertTrue(literal not in result.stdout + result.stderr, 'diagnostics must never contain the value')
            if literal in (value, backlog_fixture):
                self.assertEqual(result.returncode, 1)
                self.assertTrue(any(f['rule'] == 'SEC-3' and f['path'] == path and f['line'] == 2
                                    for f in report['findings']))
            else:
                self.assertEqual(result.returncode, 0, report)
                self.assertEqual(report['status'], 'PASS')

    def test_copy_digests_require_same_tree_regular_preimages_and_exact_locations(self):
        files = {'base/runtime/api-key.mjs': b'export const enabled = true;\n',
                 'base/runtime/token-cache.py': b'cache = {}\n'}
        for path, data in files.items():
            self.write(path, data)
        record = dict(schemaVersion=1, repository='https://example.invalid/base', copies=[dict(
            path='base/runtime', originPath='runtime', revision=secrets.token_hex(20),
            files={path: hashlib.sha256(data).hexdigest() for path, data in files.items()},
            modes={path: '100644' for path in files})])
        path = 'base-copies.json'
        self.write(path, json.dumps(record, indent=2))
        self.commit()
        self.assertEqual(self.report()['status'], 'PASS')
        # The maintained authoring default and portable record share the same
        # location-bound proof; neither can conceal a credential or bad preimage.
        self.write('base/PROVENANCE.json', json.dumps(record, indent=2))
        self.commit()
        self.assertEqual(self.report()['status'], 'PASS')
        original = self.repo / next(iter(files))
        for mutation in ('missing', 'changed', 'mode', 'symlink'):
            with self.subTest(mutation=mutation):
                if mutation == 'missing':
                    original.unlink()
                elif mutation == 'changed':
                    original.write_bytes(b'changed preimage\n')
                elif mutation == 'mode':
                    original.chmod(0o755)
                else:
                    original.unlink()
                    original.symlink_to(self.repo / 'outside.mjs')
                    self.write('outside.mjs', next(iter(files.values())))
                report = self.assert_fails('secret.assignment', path)
                self.assertTrue(any(f['scope'] == 'working-tree' for f in report['findings']))
                if original.is_symlink():
                    original.unlink()
                    (self.repo / 'outside.mjs').unlink()
                original.write_bytes(next(iter(files.values())))
                original.chmod(0o644)
        directory, moved = self.repo / 'base/runtime', self.repo / 'outside-runtime'
        directory.rename(moved)
        directory.symlink_to(moved, target_is_directory=True)
        try:
            self.assert_fails('secret.assignment', path)
        finally:
            directory.unlink()
            moved.rename(directory)
        digest = next(iter(record['copies'][0]['files'].values()))
        for key, value in (('apiKey', digest), ('api-key.mjs', secrets.token_hex(32)),
                           ('token', secrets.token_hex(20)), ('apiKey', secrets.token_hex(32))):
            with self.subTest(location=key):
                self.write(path, json.dumps({**record, key: value}, indent=2))
                report = self.assert_fails('secret.assignment', path)
                self.assertTrue(value not in json.dumps(report), 'credential bytes stay out of the report')
        self.write(path, json.dumps(record, indent=2))
        self.assertEqual(self.report()['status'], 'PASS')
        self.write('settings.mjs', json.dumps(['apiKey', secrets.token_hex(32)]))
        self.assert_fails('secret.assignment', 'settings.mjs')
        (self.repo / 'settings.mjs').unlink()
        # A correct present preimage cannot classify a mismatched historical one.
        original.write_bytes(b'old mismatched bytes\n')
        self.write(path, json.dumps(record, indent=4))
        bad = self.commit()
        original.write_bytes(next(iter(files.values())))
        self.write(path, json.dumps(record, indent=2))
        self.commit()
        report = self.assert_fails('secret.assignment', path)
        self.assertTrue(any(bad in f['commits'] and 'newly-public' in f['scopes'] for f in report['findings']))

    def test_checksum_maps_pass_only_when_every_digest_is_a_same_tree_file_hash(self):
        migrations = {'0004_heartbeat_authority.sql': b'create table a(id);\n',
                      '0005_operator_auth.sql': b'create table b(id);\n'}
        for name, data in migrations.items():
            self.write('migrations/' + name, data)
        digests = {name: hashlib.sha256(data).hexdigest() for name, data in migrations.items()}

        def baseline(entries):
            body = ''.join(f" '{name}':'{digest}',\n" for name, digest in entries.items())
            return 'export const baseline=Object.freeze({\n' + body + '});\n'

        def cli():
            result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo)],
                                    capture_output=True, text=True, timeout=120)
            report = json.loads(result.stdout)
            self.assertTrue(report['complete'])
            return report, result.stdout

        self.write('tests/baseline.mjs', baseline(digests))
        self.commit()
        self.assertEqual(cli()[0]['status'], 'PASS')
        wrong = secrets.token_hex(32)
        for label, entries in (
                ('wrong digest on the keyword-bearing name', {**digests, '0005_operator_auth.sql': wrong}),
                ('wrong digest beside a proved one', {**digests, '0004_heartbeat_authority.sql': wrong}),
                ('digest of a file the tree lacks', {**digests, '0006_missing_auth.sql': wrong}),
                ('real-looking key', {**digests, 'apiKey': wrong}),
                ('digest keyed to another file name', {'0004_heartbeat_authority.sql': digests['0005_operator_auth.sql'],
                                                      '0005_operator_auth.sql': digests['0004_heartbeat_authority.sql']})):
            with self.subTest(label):
                self.write('tests/baseline.mjs', baseline(entries))
                report, output = cli()
                self.assertEqual(report['status'], 'FAIL')
                self.assertTrue(any(f['rule'] == 'secret.assignment' and f['path'] == 'tests/baseline.mjs' for f in report['findings']))
                self.assertNotIn(wrong, output)
        self.write('tests/baseline.mjs', f"const apiKey = '{wrong}';\n")
        self.assertEqual(cli()[0]['status'], 'FAIL')

    def test_ordinary_text_is_classified_by_shape_and_real_leaks_still_fail(self):
        def png(*chunks):
            body = b'\x89PNG\r\n\x1a\n'
            for kind, data in (('IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)), *chunks, ('IEND', b'')):
                body += struct.pack('>I', len(data)) + kind.encode() + data + struct.pack('>I', zlib.crc32(kind.encode() + data))
            return body
        digest = hashlib.sha256(b'create table a(id);\n').hexdigest()
        self.write('migrations/0001_a.sql', b'create table a(id);\n')
        self.write('patches/miniflare@5.20260907.0-alpha.patch', 'diff\n')
        self.write('package.json', json.dumps({'pnpm': {'patchedDependencies': {'miniflare@5.20260907.0-alpha': 'patches/miniflare@5.20260907.0-alpha.patch'}}}))
        self.write('art.png', png(('IDAT', b'\x07' + b'1A' + b'@' + b'iM.jDe' + b'\x0f\xcc')))
        packed = b''.join(hashlib.sha256(bytes([i])).digest() for i in range(64)) + f'{secrets.token_hex(8)}@aB.cDe'.encode() + hashlib.sha256(b'x').digest()
        self.write('blob.bin', packed)
        self.write('baseline.mjs', f"export const baseline = {{ '0001_a.sql': '{digest}' }};\n")
        self.write('transport.mjs', 'export const remote = `git@github.com:${repository}`;')
        self.write('NOTES.md', 'Release receipts identify source\ncommit/tree and lock hash. The protocol stays `rer-delegation/1`; fonts came from `dmsans/v17`.')
        self.commit()
        with resolving('missing'):
            self.assertEqual(self.report()['status'], 'PASS')

        def plant(path, data, resolver='missing', rule='hygiene.email'):
            self.git('reset', '-q', '--hard', 'HEAD')
            self.write(path, data)
            self.commit()
            with resolving(lambda repository: resolver if repository.endswith('-app') else 'missing'):
                self.assert_fails(rule, path)
            self.git('reset', '-q', '--hard', 'HEAD~1')
        mailbox = f'{secrets.token_hex(8)}@{secrets.token_hex(8)}.com'
        mixed_mailbox = f'{secrets.token_hex(8)}@aB{secrets.token_hex(8)}.cOm'
        plant('package.json', json.dumps({'author': f'Jane Doe <{mixed_mailbox}>'}))
        plant('photo.png', png(('tEXt', b'Author\0' + mailbox.encode())))
        plant('latin1.csv', f'Jos\xe9 Garc\xeda,{mixed_mailbox}\n'.encode('latin-1'))
        plant('cp1252.txt', b'\x93Contact\x94 \x96 Jane Doe <' + mixed_mailbox.encode() + b'>\r\n\x85\r\n')
        plant('GUIDE.md', 'Clone `acme-org/absent-app` first.', rule='hygiene.github-missing')
        plant('GUIDE.md', 'Built from `acme-org/vault-app` internals.', resolver='private', rule='hygiene.github-private')
        plant('absent.mjs', "export const baseline = { '0006_missing_auth.sql': '" + secrets.token_hex(32) + "' };\n", rule='secret.assignment')

    def test_destination_from_project_manifest_without_edition(self):
        project = 'acme-org/absent-app'
        repository = 'https://github.com/' + project
        self.write('rer-project.json', json.dumps(dict(schema=1, projectId=project, name='Absent',
                                                       sourceRepository=repository, license='MIT')))
        self.commit()
        with resolving('missing'):
            report = self.report(project=project, repository=repository)
        self.assertEqual(report['status'], 'PASS')
        self.assertEqual(report['findings'], [])
        self.assertTrue(any(f['rule'] == 'pending-public-destination' for f in report['info']))

    def test_repository_references_resolve_in_graphql_batches_with_rest_verdicts(self):
        # GitHub's answers per repository: REST and GraphQL tell the same truth,
        # except that GraphQL refuses the SAML-protected one, which REST still
        # answers. Only this network edge is fake; the CLI, Git and Gitleaks are real.
        public = [f'acme-org/public-{index}-app' for index in range(147)]
        truth = {**dict.fromkeys(public, 'public'), 'acme-org/vault-app': 'private',
                 'acme-org/absent-app': 'missing', 'acme-org/saml-app': 'private'}
        fake = """#!/usr/bin/env python3
import json, os, sys
truth, args = json.loads(os.environ['FAKE_GITHUB']), sys.argv[1:]
with open(os.environ['FAKE_GITHUB_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if 'graphql' in args:
    fields = dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '-f')
    data, errors = {}, []
    for key in sorted(k for k in fields if k.startswith('o')):
        alias, repository = 'r' + key[1:], fields[key] + '/' + fields['n' + key[1:]]
        state = truth.get(repository, 'missing')
        data[alias] = None if state == 'missing' or repository.endswith('saml-app') else dict(
            isPrivate=state == 'private', isDisabled=False, isLocked=False)
        if repository.endswith('saml-app'):
            errors.append(dict(type='FORBIDDEN', path=[alias], message='Resource protected by organization SAML enforcement.'))
        elif state == 'missing':
            errors.append(dict(type='NOT_FOUND', path=[alias], message=f"Could not resolve to a Repository with the name '{repository}'."))
    print('HTTP/2.0 200 OK\\n\\n' + json.dumps(dict(data=data, errors=errors) if errors else dict(data=data)))
    sys.exit(1 if errors else 0)
state = truth.get(args[-1].removeprefix('repos/'), 'missing')
if state == 'missing':
    print('HTTP/2.0 404 Not Found\\n\\n' + json.dumps(dict(message='Not Found', documentation_url='https://docs.github.com/rest/repos/repos#get-a-repository', status='404')))
    sys.exit(1)
print('HTTP/2.0 200 OK\\n\\n' + json.dumps(dict(private=state == 'private')))
"""
        self.write('public.md', '\n'.join('https://github.com/' + repository for repository in public))
        for name in ('vault', 'absent', 'saml'):
            self.write(f'{name}.md', f'https://github.com/acme-org/{name}-app')
        self.commit()
        with tempfile.TemporaryDirectory() as network:
            gh, log = os.path.join(network, 'gh'), os.path.join(network, 'calls.jsonl')
            with open(gh, 'w') as file:
                file.write(fake)
            os.chmod(gh, 0o700)
            result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo)],
                capture_output=True, text=True, timeout=120,
                env={**os.environ, 'PATH': network + os.pathsep + os.environ['PATH'],
                     'FAKE_GITHUB': json.dumps(truth), 'FAKE_GITHUB_LOG': log})
            with open(log) as file:
                calls = [json.loads(line) for line in file]
        report = json.loads(result.stdout)
        # The REST verdicts: no finding for public, one each for private and
        # missing, and the SAML-protected repository is private.
        self.assertEqual(report['status'], 'FAIL')
        self.assertEqual({(f['path'], f['rule']) for f in report['findings']},
                         {('vault.md', 'hygiene.github-private'), ('absent.md', 'hygiene.github-missing'),
                          ('saml.md', 'hygiene.github-private')})
        graphql = [call for call in calls if 'graphql' in call]
        self.assertLessEqual(len(graphql), -(-len(truth) // 100))
        # Only the repository GraphQL answered with doubt takes the REST lookup.
        self.assertEqual([call[-1] for call in calls if 'graphql' not in call], ['repos/acme-org/saml-app'])

    def test_module_git_pins_preserve_credential_findings(self):
        revision = secrets.token_hex(20)
        pins = {'auth-module': revision}
        components = [
            dict(id='owner/git-module', source=dict(kind='git', moduleRevisions=dict(pins))),
            dict(id='owner/local-module', source=dict(kind='local', origin=dict(moduleRevisions=dict(pins)))),
        ]
        documents = {
            'edition.json': dict(schemaVersion=1, id='owner/edition', components=components),
            'sources.lock.json': dict(schemaVersion=1, edition='owner/edition', components=components),
            'base/PROVENANCE.json': dict(moduleCommits=dict(pins)),
        }
        def write_documents():
            for path, document in documents.items():
                self.write(path, json.dumps(document, separators=(',', ':')))
        write_documents()
        self.commit()
        with tempfile.TemporaryDirectory() as network:
            gh = os.path.join(network, 'gh')
            with open(gh, 'w') as file:
                file.write("#!/bin/sh\nprintf 'HTTP/2 200\\n\\n{\"private\":false}\\n'\n")
            os.chmod(gh, 0o700)
            def cli():
                result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo)],
                    capture_output=True, text=True, timeout=60,
                    env={**os.environ, 'PATH': network + os.pathsep + os.environ['PATH']})
                report = json.loads(result.stdout)
                self.assertTrue(report['complete'])
                self.assertEqual(result.returncode, 0 if report['status'] == 'PASS' else 1)
                return report
            self.assertEqual(cli()['status'], 'PASS')
            # The same Git ID elsewhere in the very same minified documents is
            # still an assignment; neither the file nor the value is exempt.
            for document in documents.values():
                document['apiKey'] = revision
            write_documents()
            report = cli()
            found = {(f['rule'], f['path']) for f in report['findings']}
            self.assertTrue({('secret.assignment', p) for p in documents} <= found)
            for document in documents.values():
                del document['apiKey']
            maps = [components[0]['source']['moduleRevisions'], components[1]['source']['origin']['moduleRevisions'],
                    documents['base/PROVENANCE.json']['moduleCommits']]
            # A credential in each of the declared maps must keep its finding,
            # including SHA-256-shaped values and provider-specific tokens.
            for rule, value in (
                ('secret.assignment', generic_credential()),
                ('secret.assignment', secrets.token_hex(32)),
                ('secret.provider-token', 'ghp_' + secrets.token_hex(20)),
            ):
                with self.subTest(rule=rule):
                    for mapping in maps:
                        mapping['auth-module'] = value
                    write_documents()
                    report = cli()
                    self.assertEqual(report['status'], 'FAIL')
                    found = {(f['rule'], f['path']) for f in report['findings']}
                    self.assertTrue({(rule, p) for p in documents} <= found)
                    self.assertNotIn(value, json.dumps(report))

    def test_source_metadata_preserves_credential_findings(self):
        from test_source_metadata import generated_sources, public_scan
        documents = generated_sources(self)
        self.assertEqual(public_scan(self)['status'], 'PASS')
        archive_path = next(p for p, d in documents.items() if d.get('dependencies'))
        archive = documents[archive_path]
        key = archive['key']
        lock = documents['sources.lock.json']

        # Hygiene classifies the format independently of authoring freshness:
        # missing dependency preimages, an unselected archive, stale manifest,
        # changed contents and noncanonical JSON remain digest metadata.
        dependency_path = '.edition/sources/' + archive['dependencies'][0]['key'] + '.json'
        (self.repo / dependency_path).unlink()
        (self.repo / 'edition.json').unlink()
        lock['manifest'] = secrets.token_hex(32)
        archive['files'] = {}
        for path, document in documents.items():
            if path != dependency_path:
                self.write(path, json.dumps(document, separators=(',', ':')))
        self.assertEqual(public_scan(self)['status'], 'PASS')

        def working_assignment(report, path):
            self.assertEqual(report['status'], 'FAIL')
            self.assertTrue(any(f['rule'] == 'secret.assignment' and f['path'] == path
                                and 'working-tree' in f['scopes'] for f in report['findings']))

        # A digest-shaped key is an identity only in the documented local
        # format. Neither an immutable-looking filename nor another valid
        # metadata record authorizes malformed origins, payloads or lock rows.
        malformed = []
        for mutate in (
                lambda d: d['origin'].update(revision='main'),
                lambda d: (d['origin'].pop('revision'), d['origin'].update(projection={})),
                lambda d: d['origin'].update(excludeSnapshots=0),
                lambda d: d.update(files={'README.md': 'not a file record'})):
            changed = json.loads(json.dumps(archive))
            changed['key'] = secrets.token_hex(32)
            mutate(changed)
            path = '.edition/sources/' + changed['key'] + '.json'
            malformed.append(path)
            self.write(path, json.dumps(changed))
        report = public_scan(self)
        for path in malformed:
            working_assignment(report, path)
            (self.repo / path).unlink()
        for mutate in (
                lambda d: d['components'][0]['source'].update(revision='main'),
                lambda d: d['components'][0]['source'].update(excludeSnapshots=0),
                lambda d: d.update(files={'README.md': 'not a file record'}),
                lambda d: d['components'][0]['baseline'].pop('digest')):
            changed = json.loads(json.dumps(lock))
            mutate(changed)
            self.write('sources.lock.json', json.dumps(changed))
            working_assignment(public_scan(self), 'sources.lock.json')
        self.write('sources.lock.json', json.dumps(lock))

        # A supported projection is an origin identity, never permission to
        # conceal an extra credential in the same minified origin object.
        projected_path = next(p for p, d in documents.items() if 'projection' in d.get('origin', {}))
        changed = json.loads(json.dumps(documents[projected_path]))
        changed['origin']['projection']['apiKey'] = key
        self.write(projected_path, json.dumps(changed, separators=(',', ':')))
        working_assignment(public_scan(self), projected_path)
        self.write(projected_path, json.dumps(documents[projected_path]))

        # Strict JSON is required even when an invalid member is unrelated to
        # the identity. Duplicate members must not hide a credential location.
        for extra in ('"ignored": NaN', '"ignored": Infinity', '"ignored": -Infinity',
                      '"ignored": null, "ignored": null'):
            with self.subTest(invalid_json=extra):
                for path in ('sources.lock.json', archive_path):
                    self.write(path, json.dumps(documents[path])[:-1] + ',' + extra + '}')
                report = public_scan(self)
                for path in ('sources.lock.json', archive_path):
                    working_assignment(report, path)
        # Neither nonhex credentials nor providers can masquerade as a Source
        # key; a metadata document also grants no recursive field exemption.
        for value, rule in ((generic_credential(), 'secret.assignment'),
                            ('ghp_' + secrets.token_hex(20), 'secret.provider-token')):
            for path, document in (('sources.lock.json', lock), (archive_path, archive)):
                changed = json.loads(json.dumps(document))
                (changed['parent'] if path == 'sources.lock.json' else changed)['key'] = value
                self.write(path, json.dumps(changed, separators=(',', ':')))
            report = public_scan(self)
            found = {(f['rule'], f['path']) for f in report['findings']}
            self.assertTrue({(rule, p) for p in ('sources.lock.json', archive_path)} <= found)
            self.assertNotIn(value, json.dumps(report))

        # Exact same bytes in an extra field on the same minified line must
        # fail in both metadata formats, as must arbitrary nested key fields.
        for path in ('sources.lock.json', archive_path):
            changed = {**documents[path], 'apiKey': key, 'extra': {'key': key}}
            self.write(path, json.dumps(changed, separators=(',', ':')))
        self.write('settings.json', json.dumps(dict(apiKey=secrets.token_hex(32))))
        self.write('removed.txt', 'key=' + secrets.token_hex(32))
        self.commit()
        (self.repo / 'removed.txt').unlink()
        self.commit()
        self.write('provider.json', json.dumps(dict(key='ghp_' + secrets.token_hex(20))))
        forged = secrets.token_hex(32)
        forged_path = '.edition/sources/' + forged + '.json'
        self.write(forged_path, json.dumps(dict(key=forged)))
        with tempfile.TemporaryDirectory() as directory:
            env = os.path.join(directory, 'synthetic.env')
            with open(env, 'w') as file:
                file.write('CONTENT_ID=' + key)
            report = public_scan(self, env_file=env)
        found = {(f['rule'], f['path']) for f in report['findings']}
        self.assertTrue({('secret.assignment', 'sources.lock.json'), ('secret.assignment', archive_path),
            ('secret.assignment', 'settings.json'), ('secret.assignment', 'removed.txt'),
            ('secret.provider-token', 'provider.json'), ('secret.assignment', forged_path),
            ('secret.env-match', archive_path)} <= found)
        self.assertNotIn(key, json.dumps(report).replace(archive_path, 'archive'))

    def test_private_key(self):
        import base64
        self.write('key.txt', '-----BEGIN PRIVATE KEY-----\n' + base64.b64encode(secrets.token_bytes(64)).decode() + '\n-----END PRIVATE KEY-----')
        self.commit()
        self.assert_fails('secret.private-key', 'key.txt')

    def test_explicit_fixture_value(self):
        self.write('settings.txt', 'ghp_fixture_' + secrets.token_hex(20))
        self.commit()
        self.assertEqual(self.report()['status'], 'PASS')

    def test_shallow_is_incomplete(self):
        self.commit()
        with tempfile.TemporaryDirectory() as directory:
            subprocess.check_call(['git', 'clone', '-q', '--depth=1', self.repo.as_uri(), directory], stderr=subprocess.DEVNULL)
            self.assertEqual(scan(directory)['status'], 'INCOMPLETE')

    def test_timeout(self):
        result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo),
                                 '--timeout-seconds', '0.001'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['status'], 'INCOMPLETE')

    def test_cli_usage_reports_safe_errors(self):
        value = 'synthetic-private-value-' + secrets.token_hex(16)

        def command(*args):
            return subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo), *args],
                                  capture_output=True, text=True, timeout=30)

        cases = [
            (['--bogus'], '--bogus', 'unrecognized'),
            (['--bogus=' + value, value], '--bogus', 'unrecognized'),
            (['--timeout-seconds'], '--timeout-seconds', 'expected one argument'),
            (['--timeout-seconds', 'x'], '--timeout-seconds', 'invalid timeout'),
            *[(['--timeout-seconds=' + invalid], '--timeout-seconds', 'invalid timeout')
              for invalid in (value, '0', '-1', '7201', 'nan', 'inf')],
            (['--public-base', value], '--public-base', 'expected'),
            (['--public-base', 'https://example.invalid/' + value + '#HEAD'], '--public-base', 'expected'),
            (['--p=' + value], '--p', 'ambiguous'),
            (['--help=' + value], '--help', 'ignored explicit argument'),
            ([value], None, 'unrecognized'),
        ]
        for args, flag, problem in cases:
            with self.subTest(flag=flag, problem=problem):
                result = command(*args)
                report = json.loads(result.stdout)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(report['status'], 'INCOMPLETE')
                self.assertFalse(report['complete'])
                self.assertEqual([f['rule'] for f in report['findings']], ['scan.usage'])
                finding = report['findings'][0]
                self.assertIn(problem, finding['message'])
                if flag:
                    self.assertIn(flag, finding['message'])
                self.assertIn('--help', finding['validFlags'])
                self.assertIn('--timeout-seconds', finding['validFlags'])
                self.assertEqual(len(result.stderr.splitlines()), 1)
                self.assertIn(finding['message'], result.stderr)
                self.assertIn('--help', result.stderr)
                self.assertNotIn(value, result.stdout + result.stderr)

        clean = command()
        self.assertEqual(clean.returncode, 0)
        self.assertEqual(json.loads(clean.stdout)['status'], 'PASS')
        self.assertEqual(clean.stderr, '')
        help_result = command('--help')
        self.assertEqual(help_result.returncode, 0)
        self.assertIn('--public-base', help_result.stdout)
        self.assertEqual(help_result.stderr, '')

    def test_message_and_tag(self):
        value = 'ghp_' + secrets.token_hex(20)
        self.git('commit', '--allow-empty', '-qm', value)
        self.git('tag', '-a', 'v1', '-m', value)
        report = self.assert_fails('secret.provider-token')
        self.assertEqual({f['path'] for f in report['findings']}, {'@commit-message', '@tag-message'})
        self.assertNotIn(value, json.dumps(report))

    def test_redacted_path(self):
        value = 'ghp_' + secrets.token_hex(20)
        self.write(value + '.txt', 'contact: ' + 'person' + '@' + 'gmail.com')
        self.commit()
        result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(value, result.stdout + result.stderr)
        self.assertIn('redacted-path-sha256', result.stdout)

    def test_environment_value_cannot_be_waived(self):
        value = 'synthetic-environment-value-' + secrets.token_hex(12)
        self.write('settings.txt', 'TOKEN=' + value)
        self.commit()
        with tempfile.TemporaryDirectory() as directory:
            env = os.path.join(directory, 'synthetic.env')
            with open(env, 'w') as file:
                file.write('TOKEN=' + value)
            report = self.assert_fails('secret.env-match', env_file=env)
            self.assertTrue(report['guarantees']['environmentChecked'])
            self.assertNotIn(value, json.dumps(report))


    def test_media_samples_are_not_text_and_public_base_copies_are_pre_existing(self):
        def gif(*blocks):
            # 1x1 GIF with a two-colour table; each block is (introducer, payload).
            body = b'GIF89a' + struct.pack('<HHBBB', 1, 1, 0x80, 0, 0) + b'\0\0\0\xff\xff\xff'
            for introducer, payload in blocks:
                body += introducer + bytes([len(payload)]) + payload + b'\0'
            return body + b';'

        def jpeg(xmp, scan):
            # An APP1 XMP segment, then one scan of entropy-coded bytes.
            def segment(marker, data):
                return b'\xff' + marker + struct.pack('>H', len(data) + 2) + data
            return b'\xff\xd8' + segment(b'\xe1', xmp) + segment(b'\xda', b'\x01\x01\0\0\x3f\0') + scan + b'\xff\xd9'
        pixels =(b'\x2c' + struct.pack('<HHHHB', 0, 0, 1, 1, 0) + b'\x02', b'\x07k' + b'@' + b'x9.io\x0f\x84\x51')
        self.write('.github/assets/media/preview.gif', gif(pixels))
        self.write('CONTRIBUTORS.txt', f'{secrets.token_hex(8)}@{secrets.token_hex(8)}.com\n')
        self.commit()
        with tempfile.TemporaryDirectory() as directory:
            public = os.path.join(directory, 'public.git')
            subprocess.check_call(['git', 'clone', '-q', '--bare', str(self.repo), public])
            # 60 bytes: the comment block's length byte cannot join the value.
            value = 'synthetic-environment-value-' + secrets.token_hex(16)
            environment = os.path.join(directory, 'synthetic.env')
            with open(environment, 'w') as file:
                file.write('TOKEN=' + value)

            def door(*extra):
                result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo),
                                         '--public-base', public + '#main', '--env-file', environment, *extra],
                                        capture_output=True, text=True)
                return json.loads(result.stdout)

            self.write('README.md', 'A clean fixture, now with a preview.')
            self.commit()
            report = door()
            self.assertEqual(report['status'], 'PASS', report['findings'])
            self.assertIn(('hygiene.email', 'CONTRIBUTORS.txt'), {(f['rule'], f['path']) for f in report['preExisting']})
            mailbox = f'{secrets.token_hex(8)}@{secrets.token_hex(8)}.com'
            self.write('docs/preview.gif', 'Contact: ' + mailbox + '\n')
            self.commit()
            report = door()
            self.assertEqual(report['status'], 'FAIL')
            self.assertEqual({(f['rule'], f['path']) for f in report['findings']}, {('hygiene.email', 'docs/preview.gif')})
            self.git('reset', '-q', '--hard', 'HEAD~1')
            self.write('docs/demo.gif', gif(pixels, (b'\x21\xfe', value.encode())))
            self.commit()
            report = door()
            self.assertEqual(report['status'], 'FAIL')
            self.assertEqual({(f['rule'], f['path']) for f in report['findings']}, {('secret.env-match', 'docs/demo.gif')})
            self.assertNotIn(value, json.dumps(report))
            # Metadata around the samples is still text: a GIF comment and JPEG XMP.
            self.git('reset', '-q', '--hard', 'HEAD~1')
            self.write('docs/demo.gif', gif(pixels, (b'\x21\xfe', b'Made by ' + mailbox.encode())))
            self.commit()
            report = door()
            self.assertEqual({(f['rule'], f['path']) for f in report['findings']}, {('hygiene.email', 'docs/demo.gif')})
            self.git('reset', '-q', '--hard', 'HEAD~1')
            xmp = '<rdf:Description stRef:filePath="/' + f'Users/{secrets.token_hex(4)}/Desktop/master.psd"/>'
            self.write('docs/photo.jpg', jpeg(b'http://ns.adobe.com/xap/1.0/\0' + xmp.encode(), pixels[1]))
            self.commit()
            report = door()
            self.assertEqual({(f['rule'], f['path']) for f in report['findings']}, {('hygiene.local-path', 'docs/photo.jpg')})

    def test_ai_generated_and_phone_images_scan_clean_while_metadata_emails_fail(self):
        def der(tag, *parts):
            content = b''.join(parts)
            size = len(content)
            length = bytes([size]) if size < 0x80 else bytes([0x80 | ((size.bit_length() + 7) // 8)]) + size.to_bytes((size.bit_length() + 7) // 8, 'big')
            return bytes([tag]) + length + content

        def name(*attributes):
            return der(0x30, *(der(0x31, der(0x30, der(0x06, oid), der(tag, value.encode()))) for oid, tag, value in attributes))
        common, email = bytes.fromhex('550403'), bytes.fromhex('2a864886f70d010901')
        signer = f'{secrets.token_hex(6)}@{secrets.token_hex(6)}.com'
        algorithm = der(0x30, der(0x06, bytes.fromhex('2a8648ce3d040302')))
        # A C2PA signing certificate naming its holder's address in the
        # subject and the subject alternative name, as image generators sign.
        subject = name((common, 0x0c, 'Image Generator Signing'), (email, 0x16, signer))
        tbs = der(0x30, der(0xa0, der(0x02, b'\x02')), der(0x02, hashlib.sha256(b'serial').digest()[:16]), algorithm,
                  name((common, 0x0c, 'Image Generator Claim Signing CA')),
                  der(0x30, der(0x17, b'260101000000Z'), der(0x17, b'270101000000Z')), subject,
                  der(0x30, der(0x30, der(0x06, bytes.fromhex('2a8648ce3d0201')), der(0x06, bytes.fromhex('2a8648ce3d030107'))),
                      der(0x03, b'\0\x04' + hashlib.sha512(b'key').digest())),
                  der(0xa3, der(0x30, der(0x30, der(0x06, bytes.fromhex('551d11')), der(0x04, der(0x30, der(0x81, signer.encode())))))))
        certificate = der(0x30, tbs, algorithm, der(0x03, b'\0' + hashlib.sha512(b'signature').digest()))

        def box(kind, *parts):
            content = b''.join(parts)
            return struct.pack('>I', 8 + len(content)) + kind + content

        def superbox(label, *boxes):
            return box(b'jumb', box(b'jumd', hashlib.sha256(label).digest()[:16], b'\x03', label + b'\0'), *boxes)
        # COSE_Sign1 carrying the chain as a CBOR byte string under x5chain.
        signature = b'\xd2\x84\x43\xa1\x01\x26\xa1\x66x5chain\x59' + struct.pack('>H', len(certificate)) + certificate + b'\xf6\x58\x40' + hashlib.sha512(b'cose').digest()
        manifest = superbox(b'c2pa', superbox(b'urn:c2pa:' + secrets.token_hex(8).encode(), superbox(b'c2pa.signature', box(b'cbor', signature))))

        def png(*chunks):
            body = b'\x89PNG\r\n\x1a\n'
            for kind, data in (('IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)), *chunks, ('IEND', b'')):
                body += struct.pack('>I', len(data)) + kind.encode() + data + struct.pack('>I', zlib.crc32(kind.encode() + data))
            return body

        def segment(marker, data):
            return b'\xff' + marker + struct.pack('>H', len(data) + 2) + data

        def jpeg(*segments, scan):
            return b'\xff\xd8' + b''.join(segments) + segment(b'\xda', b'\x01\x01\0\0\x3f\0') + scan + b'\xff\xd9'
        # Compressed pixels that happen to spell a mailbox, in the primary
        # image and in the depth and gain-map images a phone stores after it.
        pixels = b'\x07k' + b'@' + b'x9.io\x0f\x84\x51'
        mpf = segment(b'\xe2', b'MPF\0II*\0' + hashlib.sha256(b'index').digest())
        phone = jpeg(mpf, scan=pixels) + jpeg(scan=pixels) + jpeg(scan=b'\x11q' + b'@' + b'z7.io\x9c')
        self.write('docs/generated.png', png(('caBX', manifest), ('IDAT', pixels)))
        self.write('docs/photo.jpg', phone)
        self.commit()
        report = self.report()
        self.assertEqual(report['status'], 'PASS', report['findings'])

        # An address anywhere else is still flagged: in the manifest outside
        # a certificate, in XMP, or in EXIF of a trailing image.
        mailbox = f'{secrets.token_hex(8)}@{secrets.token_hex(8)}.com'
        for path, data in (('docs/generated.png', png(('caBX', manifest + superbox(b'c2pa.assertions', box(b'json', json.dumps({'author': mailbox}).encode()))), ('IDAT', pixels))),
                           ('docs/photo.jpg', jpeg(segment(b'\xe1', b'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta dc:creator="' + mailbox.encode() + b'"/>'), scan=pixels) + jpeg(scan=pixels)),
                           ('docs/photo.jpg', phone + jpeg(segment(b'\xe1', b'Exif\0\0MM\0*\0\0\0\x08' + mailbox.encode()), scan=pixels))):
            with self.subTest(path):
                self.write(path, data)
                self.commit()
                report = self.report()
                self.assertEqual({(f['rule'], f['path']) for f in report['findings']}, {('hygiene.email', path)})
                self.git('reset', '-q', '--hard', 'HEAD~1')

    def test_controller_manifest_digests_preserve_real_credential_findings(self):
        value = secrets.token_hex(32)
        manifest = {'sourceSha': secrets.token_hex(20), 'descriptorSha256': secrets.token_hex(32),
                    'controllerDirectories': ['public'], 'controllerFiles': {'config/api-key.json': value}}
        path = 'arbitrary/review.json'
        self.write(path, json.dumps(manifest))
        self.commit()
        self.assertEqual(self.report()['status'], 'PASS')
        for malformed in ({**manifest, 'apiKey': value},
                          {**manifest, 'sourceSha': 'main'},
                          {**manifest, 'controllerFiles': {'../api-key.json': value}}):
            self.write(path, json.dumps(malformed))
            self.assert_fails('secret.assignment', path)
        self.write(path, json.dumps(manifest))
        with tempfile.TemporaryDirectory() as directory:
            environment = os.path.join(directory, 'synthetic.env')
            with open(environment, 'w') as file:
                file.write('TOKEN=' + value)
            self.assert_fails('secret.env-match', env_file=environment)
        self.write(path, json.dumps({**manifest, 'controllerFiles': {
            'config/api-key.json': 'ghp_' + secrets.token_hex(20)}}))
        self.assert_fails('secret.provider-token', path)


if __name__ == '__main__':
    unittest.main()
