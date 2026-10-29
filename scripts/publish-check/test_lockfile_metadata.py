"""Dependency contacts through the same --repo/--ref door used by seeds."""
import json
import secrets
import subprocess
import tempfile
import unittest
from test_repo import ROOT, RepositoryFixture


class LockfileMetadataTests(RepositoryFixture, unittest.TestCase):
    def public_scan(self, expected, *options):
        result = subprocess.run(['node', str(ROOT / 'scripts/publish-check.mjs'),
                                 '--repo', str(self.repo), '--ref', 'HEAD', *options],
                                capture_output=True, text=True, timeout=120)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, expected, report)
        self.assertEqual(report['status'], 'PASS' if expected == 0 else 'FAIL')
        self.assertTrue(report['complete'])
        return report

    def documents(self):
        address = 'i' + '@' + 'izs.me'
        person = dict(name='Package maintainer', email=address, url='https://example.invalid')
        contacts = dict(author='Maintainer <' + address + '>', maintainer=person,
                        maintainers=[person], contributors=[address, person], email=address)
        # Easel f5b911b8 pnpm-lock.yaml:1223-1225, glob 7.2.3 registry notice.
        notice = ('Old versions of glob are not supported, and contain widely publicized security vulnerabilities, '
                  'which have been fixed in the current version. Please update. Support for old versions may be '
                  'purchased (at exorbitant rates) by contacting ' + address)
        pnpm = ("lockfileVersion: '9.0'\npackages:\n  glob@7.2.3:\n    deprecated: " + notice + '\n'
                '    author: ' + json.dumps(contacts['author']) + '\n'
                '    maintainer: ' + json.dumps(person) + '\n'
                '    contributors: ' + json.dumps(contacts['contributors']) + '\n'
                '  /@scope/package/1.0.0:\n    email: ' + address + '\n')
        package = dict(version='7.2.3', deprecated=notice, **contacts)
        npm = {f'npm{version}/package-lock.json': json.dumps(dict(lockfileVersion=version, **(
            dict(dependencies={'glob': dict(**package, dependencies={'nested': package})}) if version == 1 else
            dict(packages={'node_modules/glob': package,
                           'node_modules/@scope/package/node_modules/nested': package})))) for version in (1, 2, 3)}
        classic = ('# yarn lockfile v1\n\n"glob@^7.0.0", "glob@~7.2.3":\n  version "7.2.3"\n'
                   '  author ' + json.dumps(contacts['author']) + '\n  deprecated ' + json.dumps(notice) + '\n'
                   'other@^1:\n  version "1.0.0"\n  maintainer:\n    name "Maintainer"\n    email ' + json.dumps(address) + '\n')
        berry = '__metadata:\n  version: 8\n"glob@npm:^7.0.0":\n  version: 7.2.3\n  author: ' + json.dumps(person) + '\n  maintainers: ' + json.dumps([person]) + '\n'
        return dict({'pnpm-lock.yaml': pnpm, 'classic/yarn.lock': classic, 'berry/yarn.lock': berry}, **npm)

    def test_dependency_metadata_in_history_selected_and_working_trees(self):
        for path, content in self.documents().items():
            self.write(path, content)
        self.commit()
        self.public_scan(0)
        self.write('README.md', 'Later clean release; dependency contacts remain in history.')
        for path in self.documents():
            (self.repo / path).unlink()
        self.commit()
        self.public_scan(0)
        for path, content in self.documents().items():
            self.write(path, content)
        self.public_scan(0)

    def test_contacts_elsewhere_and_malformed_metadata_still_fail(self):
        address = 'personal-' + secrets.token_hex(4) + '@' + 'gmail.com'
        value = json.dumps(address)
        pnpm = "lockfileVersion: '9.0'\npackages:\n  glob@7.2.3:\n    author: " + value + '\n'
        npm = '{"lockfileVersion":3,"packages":{"node_modules/glob":{"version":"7.2.3","author":' + value
        cases = [
            ('pnpm-lock.yaml', pnpm + '    custom: ' + value),
            ('pnpm-lock.yaml', pnpm + '    # ' + address),
            ('pnpm-lock.yaml', pnpm + '# ' + address),
            ('pnpm-lock.yaml', pnpm.replace('author: ' + value, 'author: ' + value + ' # ' + address)),
            ('pnpm-lock.yaml', pnpm + 'email: ' + value),
            ('pnpm-lock.yaml', pnpm + 'importers:\n  .:\n    author: ' + value),
            ('pnpm-lock.yaml', pnpm + 'snapshots:\n  glob@7.2.3:\n    email: ' + value),
            ('pnpm-lock.yaml', pnpm.replace('glob@7.2.3:', 'custom:')),
            ('pnpm-lock.yaml', pnpm.replace('author: ' + value, 'author: {custom: ' + value + '}')),
            ('pnpm-lock.yaml', pnpm + '    author: ' + value),  # duplicate member
            ('pnpm-lock.yaml', pnpm + '    custom: ['),  # malformed document
            ('package-lock.json', npm + ',"custom":' + value + '}}}'),  # same minified line
            ('package-lock.json', npm + '}},"email":' + value + '}'),
            ('package-lock.json', '{"lockfileVersion":3,"packages":{"":{"author":' + value + '}}}'),
            ('package-lock.json', npm + ',"author":' + value + '}}}'),
            ('package-lock.json', npm + '}}} trailing data'),
            ('package-lock.json', npm.replace('node_modules/glob', 'custom') + '}}}'),
            ('yarn.lock', '# yarn lockfile v1\nglob@^7:\n  author ' + value + '\n  custom ' + value),
            ('yarn.lock', '# yarn lockfile v1\nglob@^7:\n  author ' + value + ' # ' + address),
            ('yarn.lock', '# yarn lockfile v1\nglob@^7:\n  author ' + value + '\ninvalid later record'),
            ('yarn.lock', '__metadata:\n  version: 8\n"glob@npm:^7":\n  author: ' + value + '\n  custom: ' + value),
            ('yarn.lock', '__metadata:\n  version: 8\n  email: ' + value),
            ('package.json', json.dumps(dict(name='repository', author=address))),
            *[(f'contact.{ext}', address) for ext in ('mjs', 'ts', 'md')],
        ]
        paths = []
        for index, (path, content) in enumerate(cases):
            path = f'case-{index}/{path}'
            paths.append(path)
            self.write(path, content)
        self.commit()
        report = self.public_scan(1)
        self.assertEqual({f['path'] for f in report['findings'] if f['rule'] == 'hygiene.email'}, set(paths))
        self.assertNotIn(address, json.dumps(report))

    def test_other_rules_still_inspect_package_metadata(self):
        token = 'ghp_' + secrets.token_hex(20)
        address = 'maintainer' + '@' + 'gmail.com'
        self.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  package@1.0.0:\n    author: " +
                   json.dumps('Maintainer <' + address + '> ' + '/home/' + 'private-user/notes ' + token) + '\n')
        with tempfile.TemporaryDirectory(prefix='publish-contact-env-') as directory:
            from pathlib import Path
            env_file = Path(directory) / 'values.env'
            env_file.write_text('CONTACT_TOKEN=' + token + '\n')
            report = self.public_scan(1, '--env-file', str(env_file))
        rules = {f['rule'] for f in report['findings'] if f['path'] == 'pnpm-lock.yaml'}
        self.assertTrue({'secret.env-match', 'hygiene.local-path'} <= rules, report)
        self.assertNotIn('hygiene.email', rules)
        self.assertNotIn(token, json.dumps(report))
