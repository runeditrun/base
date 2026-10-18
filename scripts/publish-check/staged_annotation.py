"""Include the actual staged Git tag in the source scan's message policy."""
import hashlib
from pathlib import Path
from git_history import InspectionError
from report import new_report, finish


def load(path, commit):
    if path is None:
        return None
    raw = Path(path).read_bytes()
    header, separator, message = raw.partition(b'\n\n')
    if not separator or not header.startswith(('object ' + commit + '\ntype commit\n').encode()):
        raise InspectionError('scan.annotation-invalid')
    digest = hashlib.sha1 if len(commit) == 40 else hashlib.sha256
    oid = digest(b'tag ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    return dict(oid=oid, message=message)


def messages(history, staged):
    yield from history.messages()
    if staged:
        yield 'tag', staged['oid'], staged['message']


def summary(report, staged):
    if not staged:
        return
    annotation = new_report(report.get('publicBase') is not None)
    annotation.update(source=report['source'], publicBase=report.get('publicBase'),
                      implementation=report['implementation'])
    annotation['history'].update(scope='staged-annotation', tagMessages=1)
    annotation['guarantees']['environmentChecked'] = report['guarantees']['environmentChecked']
    for bucket in ('findings', 'preExisting', 'warnings', 'fixtures', 'reviewed', 'info'):
        annotation[bucket] = [{**item, 'commit': staged['oid'], 'commits': [staged['oid']]}
                              for item in report[bucket] if staged['oid'] in item['commits']]
    if not report['complete']:
        annotation['findings'].append(dict(rule='scan.source-incomplete', path='.'))
    report['annotationInspection'] = finish(annotation)
