"""Exact upstream licence texts whose copyright notices are third-party public text, maintained by Base only."""
import hashlib
import json
import re
from pathlib import Path
from publication_config import unique_object

RULE = 'notice.third-party'
LICENCE_NAMES = frozenset({'LICENSE', 'LICENCE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'})
FIELDS = {'blob', 'package', 'version', 'licence', 'source', 'reason'}


def blob_id(data):
    # Git's object identity of these exact bytes, also for files with no tree entry.
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def third_party_notices():
    path = Path(__file__).with_name('third-party-notices.json')
    document = json.loads(path.read_bytes(), object_pairs_hook=unique_object)
    if (not isinstance(document, dict) or set(document) != {'schemaVersion', 'notices'} or
            document['schemaVersion'] != 1 or not isinstance(document['notices'], list)):
        raise ValueError('invalid third-party notices')
    notices = {}
    for entry in document['notices']:
        if (not isinstance(entry, dict) or set(entry) != FIELDS or
                not all(isinstance(entry[k], str) and entry[k].strip() for k in FIELDS) or
                not re.fullmatch(r'[0-9a-f]{40}', entry['blob']) or entry['blob'] in notices):
            raise ValueError('invalid third-party notice')
        notices[entry['blob']] = entry
    return notices


def notice(path, data, notices):
    """The listed notice these exact bytes are, only under a licence file name."""
    if path.rsplit('/', 1)[-1] not in LICENCE_NAMES:
        return None
    return notices.get(blob_id(data))
