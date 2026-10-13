"""Exact digest locations in immutable standalone-controller review manifests.

The live-proof controller verifies these digests against its pinned Git source
before executing any copied file. This identifies the documented format; it does
not claim to perform that remote integrity check during publication inspection.
"""
from copy_identities import relative_path
from json_identity import HEX, GIT_REVISION


def controller_pointers(value):
    if not isinstance(value, dict) or set(value) != {
            'sourceSha', 'descriptorSha256', 'controllerDirectories', 'controllerFiles'}:
        return
    if (not isinstance(value['sourceSha'], str) or not GIT_REVISION.fullmatch(value['sourceSha'])
            or not isinstance(value['descriptorSha256'], str)
            or not HEX.fullmatch(value['descriptorSha256'])):
        return
    directories, files = value['controllerDirectories'], value['controllerFiles']
    if (not isinstance(directories, list) or not all(relative_path(p) for p in directories)
            or len(set(directories)) != len(directories)
            or not isinstance(files, dict) or not files
            or not all(relative_path(p) and isinstance(digest, str) and HEX.fullmatch(digest)
                       for p, digest in files.items())
            or any(directory == path or directory.startswith(path + '/')
                   for directory in directories for path in files)):
        return
    yield ('sourceSha',)
    yield ('descriptorSha256',)
    for path in files:
        yield ('controllerFiles', path)
