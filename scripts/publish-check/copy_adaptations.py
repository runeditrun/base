"""Classify adaptations recorded by adapt-base in the root copy inventory."""
import hashlib
import re

from copy_identities import relative_path as relative_copy_path
from json_identity import GIT_REVISION, HEX

MODES = ('100644', '100755')
RECORD_FIELDS = {'schemaVersion', 'copies', 'ignore', 'repository'}
COPY_FIELDS = {'path', 'originPath', 'revision', 'files', 'modes', 'originFiles', 'adapted', 'acknowledged'}


def relative_path(value):
    # JSON can decode escaped lone surrogates that cannot name a UTF-8 Git path.
    return relative_copy_path(value) and re.search(r'[\ud800-\udfff]', value) is None


def within(name, root):
    return name == root or name.startswith(root + '/')


def hex_string(value, pattern):
    return isinstance(value, str) and pattern.fullmatch(value)


def valid_record(record):
    if (not isinstance(record, dict) or record.keys() - RECORD_FIELDS
            or type(record.get('schemaVersion')) is not int or record['schemaVersion'] != 1
            or not isinstance(record.get('copies'), list)):
        return False
    repository, ignored = record.get('repository', 'runeditrun/base'), record.get('ignore', [])
    if (not isinstance(repository, str) or not repository or repository.startswith('-')
            or not isinstance(ignored, list) or not all(map(relative_path, ignored))):
        return False
    paths = set()
    for copy in record['copies']:
        if (not isinstance(copy, dict) or copy.keys() - COPY_FIELDS
                or not relative_path(copy.get('path')) or not relative_path(copy.get('originPath'))
                or not hex_string(copy.get('revision'), GIT_REVISION)):
            return False
        path, origin = copy['path'], copy['originPath']
        if any(within(path, other) or within(other, path) for other in paths):
            return False
        paths.add(path)
        files, modes = copy.get('files'), copy.get('modes', {})
        adapted, acknowledged = copy.get('adapted', {}), copy.get('acknowledged', {})
        if not all(isinstance(mapping, dict) for mapping in (files, modes, adapted, acknowledged)) or not files:
            return False
        if any(not relative_path(name) or not within(name, path) or not hex_string(digest, HEX)
               for name, digest in files.items()):
            return False
        if (any(name not in files or mode not in MODES for name, mode in modes.items())
                or any(name not in files or not hex_string(revision, GIT_REVISION)
                       for name, revision in adapted.items())
                or any(name not in adapted or not isinstance(snapshot, dict) or snapshot.keys() != {'sha256', 'mode'}
                       or not hex_string(snapshot['sha256'], HEX) or snapshot['mode'] not in MODES
                       for name, snapshot in acknowledged.items())):
            return False
        if 'originFiles' in copy:
            names = copy['originFiles']
            if not isinstance(names, list) or any(not relative_path(name) or not within(name, origin) for name in names):
                return False
            members = set(names)
            if len(members) != len(names) or any(origin + name[len(path):] not in members for name in files.keys() - adapted.keys()):
                return False
    return True


def adaptation_pointers(record, read_regular, read_origin):
    if not valid_record(record):
        return set()
    allowed = set()
    for index, copy in enumerate(record['copies']):
        for name, snapshot in copy.get('acknowledged', {}).items():
            local = read_regular(name)
            if not local or local[1] != snapshot['mode'] or hashlib.sha256(local[0]).hexdigest() != snapshot['sha256']:
                continue
            prefix = ('copies', index)
            allowed.add((*prefix, 'acknowledged', name, 'sha256'))
            # An adapted file changed locally. Its baseline digest still needs
            # a byte and mode proof, now against the original pinned Base tree.
            revision = copy['adapted'][name]
            origin = copy['originPath'] + name[len(copy['path']):]
            baseline = (copy['files'][name], copy.get('modes', {}).get(name))
            if baseline[1] and read_origin(revision, origin) == baseline:
                allowed.update({(*prefix, 'adapted', name), (*prefix, 'files', name)})
    return allowed
