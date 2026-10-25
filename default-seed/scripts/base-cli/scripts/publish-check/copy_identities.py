"""Prove copy-inventory digests against regular files in the scanned tree."""
import hashlib
import re
from json_identity import HEX, GIT_REVISION


def relative_path(value):
    return (isinstance(value, str) and value and not value.startswith('/')
            and not re.search(r'[\\\x00-\x1f\x7f]', value)
            and all(part not in ('', '.', '..', '.git') for part in value.split('/')))


def copy_pointers(document, read_regular, read_origin=None):
    if (not isinstance(document, dict) or type(document.get('schemaVersion')) is not int
            or document['schemaVersion'] != 1 or not isinstance(document.get('copies'), list)):
        return set()
    allowed = set()
    remaining = 4096
    for index, copy in enumerate(document['copies']):
        if (not isinstance(copy, dict) or not relative_path(copy.get('path'))
                or not relative_path(copy.get('originPath'))
                or not isinstance(copy.get('revision'), str)
                or not GIT_REVISION.fullmatch(copy['revision'])):
            continue
        files, modes = copy.get('files'), copy.get('modes')
        if (not isinstance(files, dict) or not files or len(files) > remaining or not isinstance(modes, dict)
                or set(files) != set(modes)):
            continue
        remaining -= len(files)
        adapted, acknowledged = copy.get('adapted', {}), copy.get('acknowledged', {})
        if not isinstance(adapted, dict) or not isinstance(acknowledged, dict):
            continue
        for name, digest in files.items():
            if (not relative_path(name) or not (name == copy['path'] or name.startswith(copy['path'] + '/'))
                    or not isinstance(digest, str) or not HEX.fullmatch(digest)
                    or modes[name] not in ('100644', '100755')):
                continue
            pointer = ('copies', index)
            value = read_regular(name)
            if name not in adapted:
                if (value is not None and value[1] == modes[name]
                        and hashlib.sha256(value[0]).hexdigest() == digest):
                    allowed.add((*pointer, 'files', name))
                continue
            revision, local = adapted[name], acknowledged.get(name)
            if (not isinstance(revision, str) or not GIT_REVISION.fullmatch(revision)
                    or not isinstance(local, dict) or not isinstance(local.get('sha256'), str)
                    or not HEX.fullmatch(local['sha256']) or local.get('mode') not in ('100644', '100755')):
                continue
            # The local acknowledgement admits this adaptation. It cannot
            # prove the baseline: that needs a separate origin preimage below.
            acknowledged_here = (value is not None and value[1] == local['mode']
                                 and hashlib.sha256(value[0]).hexdigest() == local['sha256'])
            if acknowledged_here:
                allowed.add((*pointer, 'acknowledged', name, 'sha256'))
            origin_path = copy['originPath'] + name[len(copy['path']):]
            origin = read_origin(revision, origin_path) if read_origin else None
            if (acknowledged_here and origin is not None and origin[1] == modes[name]
                    and hashlib.sha256(origin[0]).hexdigest() == digest):
                allowed.add((*pointer, 'files', name))
                allowed.add((*pointer, 'adapted', name))
    return allowed
