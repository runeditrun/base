"""Fetch missing promised history in one pack before inspecting any blobs."""
from time import monotonic
from git_history import InspectionError


def missing_blob(history, oid):
    # Sizes need the blob itself. Locate a promised object using tree entries
    # without -l, so a failed fetch cannot trigger another lazy fetch.
    trees = set(history.run('log', '--format=%T', *history.revisions).splitlines())
    for tree in sorted(trees):
        for record in history.run('ls-tree', '-r', '-z', tree.decode()).split(b'\0'):
            metadata, separator, path = record.partition(b'\t')
            if separator and metadata.split()[2].decode() == oid:
                return InspectionError(f'missing blob {oid} at {path.decode(errors="replace")}: fetch the full history')
    return InspectionError(f'missing blob {oid} at <unknown path>: fetch the full history')


def prepare(history):
    started = monotonic()
    def missing():
        return sorted(line[1:] for line in
                      history.run('rev-list', '--objects', '--missing=print', *history.revisions).splitlines()
                      if line.startswith(b'?'))
    before = missing()
    fetches = 0
    if before:
        # A blob:none clone already owns the commits and trees. ls-tree -l and
        # cat-file would otherwise ask its promisor for one blob at a time.
        try:
            remotes = history.run('config', '--get-regexp', r'^remote\..*\.promisor$').decode().splitlines()
        except InspectionError:
            remotes = []
        names = [line.rsplit(None, 1)[0][len('remote.'):-len('.promisor')]
                 for line in remotes if line.rsplit(None, 1)[-1].lower() == 'true']
        if len(names) != 1:
            raise missing_blob(history, before[0].decode())
        try:
            # Explicit object wants cover selected commits fetched outside the
            # remote's configured branch refspecs too. stdin keeps one batch
            # even when a full history exceeds the command argument limit.
            # Refetch encourages automatic repacking. Detached maintenance can
            # outlive inspection and write into a caller's disposable repo
            # during cleanup, so hydration must not start it.
            history.run('fetch', '--quiet', '--refetch', '--no-filter', '--no-tags',
                        '--no-auto-maintenance', '--no-recurse-submodules', '--no-write-fetch-head', '--stdin', '--', names[0],
                        input=b'\n'.join(before) + b'\n')
        except InspectionError:
            raise missing_blob(history, before[0].decode()) from None
        fetches = 1
    after = missing() if before else []
    if after:
        raise missing_blob(history, after[0].decode())
    return dict(missingBefore=len(before), missingAfter=len(after), fetches=fetches,
                seconds=round(monotonic() - started, 6))
