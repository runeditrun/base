"""Public scanner journeys across native fragments in copy inventories."""
import hashlib
import json
import secrets
import unittest
from gitleaks import executable, inspect
from test_repo import RepositoryFixture, generic_credential
from test_source_metadata import public_scan


class CopyDigestTests(RepositoryFixture, unittest.TestCase):
    def test_multibyte_json_offsets_preserve_only_exact_identity_matches(self):
        files = {'vendor/base/api-key-one.mjs': b'export const first = true;\n',
                 'vendor/base/api-key-two.mjs': b'export const second = true;\n'}
        for path, data in files.items():
            self.write(path, data)
        revision = secrets.token_hex(20)
        digests = {path: hashlib.sha256(data).hexdigest() for path, data in files.items()}
        record = dict(schemaVersion=1, padding='é中🌍 "\\',
                      moduleCommits={'operator-auth': revision}, copies=[dict(
                          padding='naïve 🌱', path=path, originPath='runtime/' + path.rsplit('/', 1)[-1],
                          revision=revision, files={path: digest}, modes={path: '100644'})
                          for path, digest in digests.items()])
        path = 'base/PROVENANCE.json'
        for pretty in (True, False):
            with self.subTest(pretty=pretty):
                def serialized(value):
                    return json.dumps(value, ensure_ascii=False, indent=2 if pretty else None,
                                      separators=None if pretty else (',', ':'))
                self.write(path, serialized(record))
                self.commit()
                hits = inspect(executable(), 'dir', repo=str(self.repo), redact=False)
                # Real native matches must exercise both digest lengths. PASS
                # requires the JSON spans to land on their exact UTF-8 bytes.
                for value in (revision, *digests.values()):
                    self.assertTrue(any(h['RuleID'] in ('generic-api-key', 'hex-api-key')
                                        and h['Secret'] == value for h in hits))
                self.assertEqual(public_scan(self)['status'], 'PASS')
                self.write(path, serialized({**record, 'between': '雪🌍',
                                             'apiKey': next(iter(digests.values()))}))
                report = public_scan(self)
                self.assertEqual(report['status'], 'FAIL')
                self.assertTrue(any(f['path'] == path and f['rule'] == 'secret.assignment'
                                    and 'working-tree' in f['scopes'] for f in report['findings']))

    def test_partial_copy_digest_captures_keep_credentials_and_bad_preimages(self):
        name = 'vendor/base/operator-auth/accounts/schema/operator-auth.sql'
        data = b'create table operators(id);\n'
        digest = hashlib.sha256(data).hexdigest()
        self.write(name, data)
        record = dict(schemaVersion=1, padding='', copies=[dict(
            path=name, originPath='modules/operator-auth/accounts/schema/operator-auth.sql',
            revision=secrets.token_hex(20), files={name: digest}, modes={name: '100644'})])
        for path in ('base-copies.json', 'base/PROVENANCE.json', 'custom-copies.json'):
            for pretty in (True, False):
                with self.subTest(path=path, pretty=pretty):
                    def serialized():
                        return json.dumps(record, indent=2 if pretty else None,
                                          separators=None if pretty else (',', ':'))
                    record['padding'] = ''
                    # Gitleaks' first directory fragment ends inside this JSON
                    # value, as in Vector's inventory. The capture is real, not
                    # a manufactured native report or a pinned digest value.
                    offset = serialized().encode().index(digest.encode())
                    record['padding'] = 'x' * (125_000 - offset - 55)
                    self.write(path, serialized())
                    self.commit()
                    hits = inspect(executable(), 'dir', repo=str(self.repo), redact=False)
                    self.assertTrue(any(h['RuleID'] == 'generic-api-key'
                                        and 0 < len(h['Secret']) < len(digest)
                                        and h['Secret'] in digest for h in hits))
                    self.assertEqual(public_scan(self)['status'], 'PASS')
                    for key in (digest, generic_credential(), 'ghp_' + secrets.token_hex(20)):
                        self.write(path, serialized()[:-1] + ',"apiKey":' + json.dumps(key) + '}')
                        report = public_scan(self)
                        self.assertEqual(report['status'], 'FAIL')
                        self.assertTrue(any(f['path'] == path and f['rule'].startswith('secret.')
                                            and 'working-tree' in f['scopes'] for f in report['findings']))
                        self.assertNotIn(key, json.dumps(report))
                    self.write(path, serialized())
                    self.write(name, b'changed copy\n')
                    self.assertEqual(public_scan(self)['status'], 'FAIL')
                    self.write(name, data)
                    (self.repo / path).unlink()
                    self.commit()


if __name__ == '__main__':
    unittest.main()
