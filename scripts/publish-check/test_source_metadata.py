"""Real authoring-generated metadata and a public-CLI test boundary."""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from test_repo import ROOT, RepositoryFixture


def generated_sources(fixture):
    source = RepositoryFixture()
    source.setUp()
    fixture.addCleanup(source.tearDown)
    # A credential-shaped filename exercises the lock's file-content digest.
    source.write('auth-key.mjs', 'export const enabled = true;\n')
    source.commit()
    repository = os.path.relpath(source.repo, fixture.repo)
    ref = dict(repository=repository, revision=source.git('rev-parse', 'HEAD'), path='README.md')
    program = """
      import {snapshot} from './edition-authoring/sources.mjs';
      import {json} from './edition-authoring/files.mjs';
      process.chdir(process.argv[1]);
      process.stdout.write(json(snapshot(process.argv[1], JSON.parse(process.argv[2]))));
    """
    archive = subprocess.check_output(['node', '--input-type=module', '-e', program,
        str(fixture.repo), json.dumps(ref)], cwd=ROOT)
    saved = json.loads(archive)
    source.write('.edition/sources/' + saved['key'] + '.json', archive)
    revision = source.commit()
    toolchain = dict(id='runeditrun/edition-authoring', version='1.1.0')
    recipe = dict(schemaVersion=1, id='owner/edition', toolchain=toolchain,
        parent=dict(repository=repository, revision=revision), components=[dict(
            id='owner/source', role='module', source=dict(kind='git', destination='module',
                repository=repository, revision=revision, path='auth-key.mjs'))])
    fixture.write('edition.json', json.dumps(recipe))
    fixture.commit()
    subprocess.run(['node', str(ROOT / 'edition-authoring/cli.mjs'), 'lock'], cwd=fixture.repo,
                   check=True, capture_output=True)
    # Adopt a reviewed projection with the maintained origin serializer and
    # binding protocol, then exercise the real authoring lock/check doors.
    program = """
      import fs from 'node:fs';
      import {hash, json, digest} from './edition-authoring/files.mjs';
      import {snapshotOrigin} from './edition-authoring/projection-lock.mjs';
      const original = JSON.parse(fs.readFileSync(0, 'utf8'));
      const ref = {repository: 'https://example.invalid/projected-source', projection: {
        schemaVersion: 1, originalSha256: hash(json(original)), recipeSha256: hash(json({retain: ['README.md']}))}};
      const origin = snapshotOrigin(ref);
      const saved = {key: hash(json(origin)), origin, digest: digest(original.files), files: original.files, dependencies: []};
      process.stdout.write(JSON.stringify({ref, saved, bytes: json(saved), pin: {
        key: saved.key, digest: saved.digest, sha256: hash(json(saved))}}));
    """
    projected = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', program], input=archive, cwd=ROOT))
    fixture.write('.edition/sources/' + projected['saved']['key'] + '.json', projected['bytes'])
    component = dict(id='owner/projected', role='module', source=dict(kind='local', paths=['README.md'], origin=projected['ref']))
    recipe['components'].append(component)
    fixture.write('edition.json', json.dumps(recipe))
    lock = json.loads((fixture.repo / 'sources.lock.json').read_bytes())
    lock['components'].append(dict(id=component['id'], source=component['source'], baseline=projected['pin']))
    fixture.write('sources.lock.json', json.dumps(lock))
    for command in ('lock', 'check'):
        subprocess.run(['node', str(ROOT / 'edition-authoring/cli.mjs'), command], cwd=fixture.repo,
                       check=True, capture_output=True)
    fixture.commit()
    paths = ['sources.lock.json', *(p.relative_to(fixture.repo).as_posix()
             for p in sorted((fixture.repo / '.edition/sources').glob('*.json')))]
    return {p: json.loads((fixture.repo / p).read_bytes()) for p in paths}


def public_scan(fixture, scanner=ROOT, env_file=None, base_origin=None):
    # Only the GitHub network edge is fake; Git, authoring and Gitleaks are real.
    with tempfile.TemporaryDirectory() as network:
        gh = Path(network) / 'gh'
        gh.write_text("#!/bin/sh\nprintf 'HTTP/2 200\\n\\n{\"private\":false}\\n'\n")
        gh.chmod(0o700)
        if base_origin is not None:
            git = Path(network) / 'git'
            git.write_text('#!/usr/bin/env python3\nimport os, sys\n'
                + 'args = [' + repr(str(base_origin)) + " if a == 'https://github.com/runeditrun/base.git' else a for a in sys.argv[1:]]\n"
                + 'os.execv(' + repr(shutil.which('git')) + ', [\'git\', *args])\n')
            git.chmod(0o700)
        args = ['node', str(scanner / 'scripts/publish-check.mjs'), '--repo', str(fixture.repo)]
        if env_file:
            args.extend(['--env-file', str(env_file)])
        result = subprocess.run(args, capture_output=True, text=True, timeout=60,
            env={**os.environ, 'PATH': network + os.pathsep + os.environ['PATH']})
    report = json.loads(result.stdout)
    fixture.assertTrue(report['complete'])
    fixture.assertEqual(result.returncode, 0 if report['status'] == 'PASS' else 1)
    return report
