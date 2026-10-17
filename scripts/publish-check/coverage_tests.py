"""Retained public-text/licence rules, exercised through real Git history."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_repo import ROOT, RepositoryFixture, resolving, LICENSE, generic_credential


class HygieneTests(RepositoryFixture, unittest.TestCase):
    def deleted(self, path, data, rule):
        self.write(path, data)
        self.commit()
        (self.repo / path).unlink()
        self.commit()
        return self.assert_fails(rule, path)

    def test_email_in_history(self):
        self.deleted('contact.txt', 'person' + '@' + 'gmail.com', 'hygiene.email')

    def test_reserved_domains_are_not_personal_email(self):
        self.write('personas.txt', 'admin' + '@' + 'dev.localhost owner' + '@' + 'example.com')
        self.commit()
        self.assertFalse(any(f['rule'] == 'hygiene.email' for f in self.report()['findings']))

    def test_long_retained_runs_finish_without_hiding_private_email(self):
        mailbox = 'person' + '@' + 'gmail.com'
        self.write('retained.txt', '\n'.join(('A' * 64000, '.-' * 32000,
                                             'YWJjZGVm' * 8000, mailbox)))
        self.commit()
        result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo)],
                                capture_output=True, text=True, timeout=5)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(report['complete'])
        self.assertEqual({(f['rule'], f['path']) for f in report['findings']},
                         {('hygiene.email', 'retained.txt')})

    def test_copied_auth_documentation_needs_no_publication_exceptions(self):
        guide = (ROOT / 'modules/operator-auth/identity/oidc/README.md').read_text()
        sources = {'CLOUDFLARE_API_TOKEN': 'Owner-account deployment instructions in OPERATIONS.md'}
        self.write('docs/identity.md', guide)
        self.write('OPERATIONS.json', json.dumps({'version': 2, 'environmentSources': sources}))
        self.commit()

        def publication():
            result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'), '--repo', str(self.repo)],
                                    capture_output=True, text=True, timeout=30)
            report = json.loads(result.stdout)
            return result.returncode, report, result.stdout + result.stderr

        code, report, _ = publication()
        self.assertEqual(code, 0)
        self.assertTrue(report['complete'])
        self.assertEqual(report['findings'], [])
        self.assertEqual(report['preExisting'], [])
        self.assertEqual(report['reviewed'], [])

        # Environment references and an OIDC method identifier are public
        # configuration. Replacing a reference with a stored credential must
        # still fail, even on the same line as the method identifier.
        credential = generic_credential()
        self.write('docs/identity.md', guide.replace('clientSecret: env.GOOGLE_CLIENT_SECRET',
                                                    "clientSecret: '" + credential + "'"))
        self.write('OPERATIONS.json', json.dumps({'version': 2, 'environmentSources': {
            **sources, 'MAIL_API_KEY': credential}}))
        self.commit()
        code, report, output = publication()
        self.assertEqual(code, 1)
        self.assertTrue(report['complete'])
        self.assertEqual({finding['path'] for finding in report['findings'] if finding['rule'] == 'secret.assignment'},
                         {'docs/identity.md', 'OPERATIONS.json'})
        self.assertNotIn(credential, output)

    def test_font_licence_notice_is_required_attribution_only_inside_the_licence_text(self):
        foundry = 'type' + '@' + 'foundry-fixture.com'
        notice = 'Copyright (c) 2014 Fixture Foundry (' + foundry + ')\n'
        licence = ('\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n\n'
                   '-----------------------------------------------------------\n'
                   'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n'
                   '-----------------------------------------------------------\n\n'
                   'PREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide development.\n\n'
                   'DEFINITIONS\n"Font Software" refers to the set of files released by the Copyright Holder(s).\n\nPERMISSION & CONDITIONS\n1) No modified version may use any Reserved Font Name.\n')
        self.write('fonts/a/LICENSE.txt', notice + licence)
        self.commit()
        self.assertEqual(self.report()['status'], 'PASS')
        # Negative controls: another address in the same file, the notice
        # without the licence text, a mere mention of the licence, and a
        # contact line that starts with Copyright but is no attribution.
        other = 'person' + '@' + 'gmail.com'
        self.write('fonts/b/LICENSE.txt', notice + 'Questions: ' + other + '\n' + licence)
        self.write('fonts/c/NOTICE.txt', notice)
        self.write('fonts/d/README.txt', notice + 'Licensed under the SIL Open Font License, Version 1.1.\n')
        self.write('fonts/e/LICENSE.txt', licence + notice)
        self.write('fonts/f/LICENSE.txt', notice + 'Copyright enquiries: ' + other + '\n' + licence)
        self.commit()
        report = self.report()
        self.assertEqual(report['status'], 'FAIL')
        self.assertEqual({f['path'] for f in report['findings'] if f['rule'] == 'hygiene.email'},
                         {'fonts/b/LICENSE.txt', 'fonts/c/NOTICE.txt', 'fonts/d/README.txt', 'fonts/e/LICENSE.txt', 'fonts/f/LICENSE.txt'})

    def test_ca_email_is_public_only_inside_a_pinned_trust_anchor_subject(self):
        # The real egress bundle: a Mozilla trust anchor's subject Name in the
        # WASM holds a CA contact email, pinned by the build's trust-bundle.json.
        tls = ROOT / 'modules/egress-service/tls'
        wasm, manifest = (tls / 'egress.wasm').read_bytes(), json.loads((tls / 'trust-bundle.json').read_text())
        for name in ('egress.wasm', 'trust-bundle.json', 'Cargo.lock'):
            self.write('tls/' + name, (tls / name).read_bytes())
        clean = self.commit()

        def findings():
            return {f['path'] for f in self.report()['findings'] if f['rule'] == 'hygiene.email'}

        def pin(data):
            self.write('tls/trust-bundle.json', json.dumps(dict(manifest, artifacts=dict(manifest['artifacts'], **{'egress.wasm': hashlib.sha256(data).hexdigest()}))))
        planted = wasm + b'\0' + ('person' + '@' + 'gmail.com').encode() + b'\0'
        changed = wasm[:-1] + bytes([wasm[-1] ^ 1])
        cases = {
            'personal email outside every anchor subject, re-pinned': ('tls/egress.wasm', lambda: (self.write('tls/egress.wasm', planted), pin(planted))),
            'same bytes at a path no manifest pins': ('tls/copy.wasm', lambda: self.write('tls/copy.wasm', wasm)),
            'pinned path whose digest changed': ('tls/egress.wasm', lambda: self.write('tls/egress.wasm', changed)),
            'roots release the Cargo.lock does not lock': ('tls/egress.wasm', lambda: self.write(
                'tls/trust-bundle.json', json.dumps(dict(manifest, roots=dict(manifest['roots'], version='1.0.8'))))),
        }
        with resolving('public'):
            self.assertEqual(self.report()['status'], 'PASS')
            for case, (path, plant) in cases.items():
                with self.subTest(case=case):
                    self.git('reset', '-q', '--hard', clean)
                    self.git('clean', '-qfd')
                    plant()
                    self.commit()
                    self.assertEqual(findings(), {path})

    def test_home_paths_in_history(self):
        self.deleted('notes.txt', '\n'.join(['/' + 'home/person/code', '/' + 'Users/person/code', 'C:' + '\\Users\\person\\code']), 'hygiene.local-path')

    def test_private_repository_in_history(self):
        with resolving('private'):
            self.deleted('source.txt', 'https://github.com/' + 'owner/private-app', 'hygiene.github-private')

    def test_missing_reference(self):
        with resolving('missing'):
            self.deleted('source.txt', 'https://github.com/' + 'owner/absent-app', 'hygiene.github-missing')

    def test_archive_path_in_code_span_is_not_a_repository(self):
        self.write('GUIDE.md', 'Save archives at `exports/x.rer`.')
        self.commit()
        with resolving('missing') as asked:
            self.assertEqual(self.report()['status'], 'PASS')
            self.assertEqual(asked, set())
            self.write('GUIDE.md', 'Save archives at `exports/x.rer`. Clone `owner/absent-app` first.')
            self.commit()
            report = self.report()
        self.assertEqual({(finding['path'], finding['rule']) for finding in report['findings']}, {('GUIDE.md', 'hygiene.github-missing')})

    def test_local_directory_in_code_span_is_a_path_but_a_real_repository_is_not(self):
        self.write('GUIDE.md', '`rer deploy` uploads `dist/client` and reads `src/base/x.ts`, `docs/a` and `scripts/b`.')
        self.commit()
        with resolving('missing') as asked:
            self.assertEqual(self.report()['status'], 'PASS')
            self.assertEqual(asked, set())
            self.write('GUIDE.md', 'Uploads `dist/client`. Clone `acme-org/real-app` first.')
            self.write('PROSE.md', 'Fork from github: acme-org/other-app, then build.')
            self.commit()
            report = self.report()
        self.assertEqual({(finding['path'], finding['rule']) for finding in report['findings']},
                         {('GUIDE.md', 'hygiene.github-missing'), ('PROSE.md', 'hygiene.github-missing')})

    def test_intended_public_references_do_not_allow_other_private_or_missing_repositories(self):
        from publication_config import intended_public_repositories
        intended = sorted(intended_public_repositories())
        self.assertTrue(intended)
        self.write('source.txt', '\n'.join('https://github.com/' + repo for repo in intended))
        self.commit()
        with resolving('missing') as asked:
            self.assertEqual(self.report()['status'], 'PASS')
            self.assertEqual(asked, set())
        owner = intended[0].split('/')[0]
        private, missing = owner + '/unlisted-private-fixture', owner + '/unlisted-missing-fixture'
        self.write('private.txt', 'https://github.com/' + private)
        self.write('missing.txt', 'https://github.com/' + missing)
        self.commit()
        with resolving(lambda repo: 'private' if repo == private else 'missing'):
            report = self.report()
        self.assertEqual(report['status'], 'FAIL')
        self.assertEqual({(finding['path'], finding['rule']) for finding in report['findings']},
                         {('private.txt', 'hygiene.github-private'), ('missing.txt', 'hygiene.github-missing')})

    def test_unresolved_reference_is_incomplete(self):
        self.write('source.txt', 'https://github.com/' + 'owner/app')
        self.commit()
        with resolving('incomplete'):
            self.assertEqual(self.report()['status'], 'INCOMPLETE')

    def test_declared_public_email(self):
        address = 'support' + '@' + 'company.com'
        self.write('contact.txt', address)
        self.write('.publish-check/config.json', json.dumps(dict(schemaVersion=1, publicEmails=[address])))
        self.commit()
        self.assertEqual(self.report()['status'], 'PASS')

    def test_invalid_config(self):
        self.write('.publish-check/config.json', '{invalid')
        self.commit()
        self.assertEqual(self.report()['status'], 'INCOMPLETE')

    def test_known_source_provenance(self):
        self.write('edition.json', json.dumps(dict(parent=dict(repository='owner/private-source', revision='a' * 40))))
        self.write('copied.txt', 'Source content\n')
        record = dict(schemaVersion=1, repository='owner/private-source', copies=[dict(
            path='copied.txt', originPath='source.txt', revision='a' * 40,
            files={'copied.txt': hashlib.sha256(b'Source content\n').hexdigest()}, modes={'copied.txt': '100644'})])
        self.write('copies.json', json.dumps(record))
        self.commit()
        with resolving('private'):
            report = self.report()
            self.assertEqual(report['status'], 'PASS')
            self.assertTrue(any(item['path'] == 'copies.json' and item['rule'] == 'provenance.declared-source' for item in report['info']))
            record['copies'][0]['revision'] = 'b' * 40
            self.write('copies.json', json.dumps(record))
            self.commit()
            self.assert_fails('hygiene.github-private', 'copies.json')

    def test_license_missing_in_history(self):
        (self.repo / 'LICENSE').unlink()
        self.commit()
        self.write('LICENSE', LICENSE)
        self.commit()
        self.assert_fails('license.missing', 'LICENSE')

    def test_license_holder(self):
        self.write('LICENSE', LICENSE.replace(b'Run Edit Run', b'Other Author'))
        self.commit()
        self.assert_fails('license.holder', 'LICENSE')

    def test_license_holder_missing(self):
        self.write('LICENSE', 'Licence without attribution')
        self.commit()
        self.assert_fails('license.holder-missing', 'LICENSE')

    def test_license_unreadable(self):
        self.write('LICENSE', b'\xff')
        self.commit()
        self.assert_fails('license.unreadable', 'LICENSE')

    def test_exact_licence_exception(self):
        foreign = LICENSE.replace(b'Run Edit Run', b'Other Author')
        self.write('LICENSE', foreign)
        self.write('PUBLISH-EXCEPTIONS.json', json.dumps(dict(schemaVersion=1, exceptions=[dict(rule='license.holder',
            path='LICENSE', holder='Other Author', date='2026-01-01', sha256=hashlib.sha256(foreign).hexdigest(), reason='Retained attribution.')])))
        self.commit()
        self.assertEqual(self.report()['status'], 'PASS')


if __name__ == '__main__':
    unittest.main()
