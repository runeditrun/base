"""Fetch missing promised history in one pack before inspecting any blobs."""
from time import monotonic
from git_history import InspectionError


def prepare(history):
    started = monotonic()
    def missing():
        return sum(line.startswith(b'?') for line in
                   history.run('rev-list', '--objects', '--missing=print', *history.revisions).splitlines())
    before = missing()
    fetches = 0
    if before:
        # A blob:none clone already owns the commits and trees. ls-tree -l and
        # cat-file would otherwise ask its promisor for one blob at a time.
        remotes = history.run('config', '--get-regexp', r'^remote\..*\.promisor$').decode().splitlines()
        names = [line.rsplit(None, 1)[0][len('remote.'):-len('.promisor')]
                 for line in remotes if line.rsplit(None, 1)[-1].lower() == 'true']
        if len(names) != 1:
            raise InspectionError('history.promisor-ambiguous')
        history.run('fetch', '--quiet', '--refetch', '--no-filter', '--no-tags',
                    '--no-recurse-submodules', '--no-write-fetch-head', '--', names[0])
        fetches = 1
    after = missing() if before else 0
    if after:
        raise InspectionError('history.missing-blob')
    return dict(missingBefore=before, missingAfter=after, fetches=fetches,
                seconds=round(monotonic() - started, 6))
