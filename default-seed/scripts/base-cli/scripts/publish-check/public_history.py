"""What already-public history still reports once the history loop skips its commits (history_scan).

A finding in a commit the public base reaches can only be a pre-existing note, except that three content outcomes make
a scan INCOMPLETE wherever they are (report.finish): a submodule, an LFS pointer and an invalid project identity. A few
native passes over the whole public history find them without listing each commit's tree. Public-only history is
otherwise covered by gitleaks git mode alone: the text, provenance, licence, context, path-name and GitHub reference
passes no longer run on it, so a scanner failure there (scan.configuration-incomplete, scan.github-incomplete,
scan.credential-assignment-incomplete) no longer makes a scan INCOMPLETE. Content a walked commit holds is inspected
as before, and --env-file walks every commit."""
import os
import subprocess
import tempfile
from git_history import InspectionError
from project_identity import FIELDS, tree_identity

LFS = b'version https://git-lfs.github.com/spec/v1'


def introductions(history):
    """(commit, mode, oid, path) for every entry of every public tree: each is added in some commit's diff against a
    parent (against each parent of a merge, and every entry of a root commit)."""
    records = history.run('log', '-z', '--raw', '--no-renames', '--no-abbrev', '--diff-merges=separate', '--root',
                          '--full-history', '--format=%x01%H', *history.public_revisions).split(b'\0')
    commit = meta = None
    for record in records:
        if meta is not None:
            mode, oid = meta[1:].split(b' ')[1:4:2]
            if mode != b'000000':
                yield commit, mode.decode(), oid.decode(), os.fsdecode(record)
            meta = None
            continue
        record = record.lstrip(b'\n')
        if record.startswith(b'\x01'):
            commit = record[1:].decode()
        elif record.startswith(b':'):
            meta = record


def root_identities(history, commits, identity_rule):
    """Each commit's root project identity, judged once per distinct set of root identity entries. The root trees are
    read in one batch instead of one ls-tree per commit, and the entries' sizes in another."""
    trees = {}
    for commit in commits:
        trees.setdefault(history.commit_tree(commit).decode(), []).append(commit)
    if not trees:
        return
    output = history.run('cat-file', '--batch', input=''.join(tree + '\n' for tree in trees).encode())
    keys, at = {}, 0
    for tree in trees:
        header_end = output.index(b'\n', at)
        oid, kind, size = output[at:header_end].split()
        if oid.decode() != tree or kind != b'tree':
            raise ValueError('unexpected root tree')
        data = output[header_end + 1:header_end + 1 + int(size)]
        at = header_end + 1 + int(size) + 1
        # Without edition.json tree_identity judges nothing (project_identity.py); its entry needs these bytes.
        entries = root_entries(data, len(tree) // 2) if b' edition.json\0' in data else {}
        if 'edition.json' in entries:
            keys.setdefault(tuple(sorted(entries.items())), []).extend(trees[tree])
    blobs = sorted({oid for key in keys for _, (mode, oid) in key if mode not in ('040000', '160000')})
    sizes = {}
    if blobs:
        listing = history.run('cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)',
                              input=''.join(oid + '\n' for oid in blobs).encode()).decode().split('\n')
        for oid, line in zip(blobs, listing):
            name, kind, size = (line.split() + ['', '', ''])[:3]
            if name != oid or kind != 'blob':
                from history_hydration import missing_blob
                raise missing_blob(history, oid)
            sizes[oid] = int(size)
    for key, key_commits in keys.items():
        entries = [dict(path=path, mode=mode, oid=oid, size=sizes.get(oid, 0),
                        kind='tree' if mode == '040000' else 'commit' if mode == '160000' else 'blob')
                   for path, (mode, oid) in key]
        for path in tree_identity(history, entries)[1]:
            for commit in key_commits:
                yield identity_rule(path), path, commit, None


def root_entries(data, width):
    """{name: (mode, oid)} for the identity documents among a raw tree object's entries."""
    entries, at = {}, 0
    while at < len(data):
        space = data.index(b' ', at)
        nul = data.index(b'\0', space)
        name = os.fsdecode(data[space + 1:nul])
        if name in FIELDS:
            entries[name] = (data[at:space].decode().rjust(6, '0'), data[nul + 1:nul + 1 + width].hex())
        at = nul + 1 + width
    return entries


def lfs_pointers(history, oids):
    """The blobs that start with an LFS pointer header, streamed through one native reader."""
    with tempfile.TemporaryFile() as listing:
        listing.write(''.join(oid + '\n' for oid in oids).encode())
        listing.seek(0)
        reader = subprocess.Popen(['git', '-C', history.repo, 'cat-file', '--batch', '--buffer'], env=history.env,
                                  stdin=listing, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for oid in oids:
                header = reader.stdout.readline().split()
                if len(header) != 3 or header[0].decode() != oid or header[1] != b'blob':
                    from history_hydration import missing_blob
                    raise missing_blob(history, oid)
                size = int(header[2])
                head = reader.stdout.read(min(size, len(LFS)))
                remaining = size - len(head) + 1
                while remaining:
                    chunk = reader.stdout.read(min(remaining, 1 << 20))
                    if not chunk:
                        raise InspectionError('history.git-failed')
                    remaining -= len(chunk)
                if head == LFS:
                    yield oid
        finally:
            reader.stdout.close()
            reader.kill()
            reader.wait()


def incompleteness(history, commits, identity_rule):
    """(rule, path, commit, oid) for every scan.* outcome the skipped public commits would have reported."""
    blobs = {}
    for commit, mode, oid, path in introductions(history):
        if mode == '160000':
            yield 'scan.submodule-uninspected', path, commit, oid
        else:
            blobs.setdefault(oid, []).append((path, commit))
    for oid in lfs_pointers(history, list(blobs)):
        for path, commit in blobs[oid]:
            yield 'scan.lfs-uninspected', path, commit, oid
    yield from root_identities(history, commits, identity_rule)


def plain(path):
    return path and '\n' not in path and not path.startswith('/') and all(
        part not in ('', '.', '..') for part in path.split('/'))


def blob_hits(history, pairs):
    """The (commit, path) pairs whose path names a blob in that commit, exactly as History.entries keys it, in one
    native lookup (a path git's <commit>:<path> syntax could read differently falls back to the commit's listing)."""
    pairs = sorted(pairs)
    lookup = [(commit, path) for commit, path in pairs if plain(path)]
    found = set()
    if lookup:
        output = history.run('cat-file', '--batch-check=%(objecttype)',
                             input=b''.join(commit.encode() + b':' + os.fsencode(path) + b'\n' for commit, path in lookup))
        lines = output.split(b'\n')[:len(lookup)]
        if len(lines) != len(lookup):
            raise ValueError('unexpected object lookup')
        found = {pair for pair, line in zip(lookup, lines) if line == b'blob'}
    for commit, path in pairs:
        if not plain(path):
            entry = next((e for e in history.entries(commit) if e['path'] == path), None)
            if entry and entry['kind'] == 'blob':
                found.add((commit, path))
    return found
