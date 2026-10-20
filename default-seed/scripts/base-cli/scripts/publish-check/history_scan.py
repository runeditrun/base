"""Scan current files and full history using native Git and pinned Gitleaks."""
from pathlib import Path
from scan_timings import Timings
import staged_annotation
from git_history import History, InspectionError
from public_base import PublicBaseError
from gitleaks import executable, inspect as secrets, rule as secret_rule
from hygiene_config import CONFIG, load_config
from github_refs import GitHubResolver, local_dependencies
from destination import destination, INVALID
from env_values import load_hashes
from licenses import EXCEPTIONS, exceptions, license_rules, registry
from reviewed import REVIEWED, load_reviewed
from report import new_report, Findings, finish
from tree_scan import context, text_rules, working_files, working_regular
from public_hygiene import reference_rules
from content_identities import ContentIdentities, candidate as identity_candidate
from checksum_maps import ChecksumMaps
from credential_assignments import text_rules, Findings


def scan(repo, ref='HEAD', public_base=None, env_file=None, project=None, repository=None, *, cache_dir=None, timeout=300, annotation_file=None):
    report = new_report(public_base is not None)
    timings = Timings(report)
    history = staged = None
    add = Findings(report, {}, frozenset()).add
    try:
        hashes = load_hashes(env_file)
        report['guarantees']['environmentChecked'] = env_file is not None
        binary = executable()
        history = timings.call('history.prepare', History, repo, ref, public_base)
        report['history']['hydration'] = history.hydration
        staged = staged_annotation.load(annotation_file, history.commit)
        report['source'] = dict(commit=history.commit, tree=history.commit_tree(history.commit).decode())
        report['publicBase'] = dict(ref=history.public_label, commit=history.public_commit) if public_base else None
        config = load_config(history.selected(CONFIG))
        reviewed_bytes = history.selected(REVIEWED)
        reviewed = load_reviewed(reviewed_bytes) if reviewed_bytes else {}
        add = Findings(report, reviewed, hashes).add
        try:
            config['pendingDestination'] = destination(history, project, repository)
        except (ValueError, TypeError, UnicodeError):
            add(INVALID, 'edition.json', history.commit)
            config['pendingDestination'] = None
        recorded = registry() + exceptions(history.selected(EXCEPTIONS))
        public_blobs = {e['oid'] for c in history.public_commits for e in history.entries(c)}
        # A file byte-identical to the same path on the public base is already public.
        public_paths = {e['path']: e['oid'] for e in history.entries(history.public_commit)
                        if e['kind'] == 'blob'} if history.public_commit else {}
        report['history']['preExistingCommits'] = sorted(history.public_commits)
        report['history']['newlyPublicCommits'] = [c for c in history.commits if c not in history.public_commits]
        seen_trees, seen_blobs, inspected = set(), set(), {}
        entries_by_commit, dependencies = {}, {}
        # Repository references wait here so that the whole scan resolves them in bulk.
        deferred = []
        release_license_good = not license_rules(history.selected('LICENSE'), recorded)
        for commit in history.commits:
            entries = history.entries(commit)
            entries_by_commit[commit] = {e['path']: e for e in entries}
            tree = history.commit_tree(commit).decode()
            seen_trees.add(tree)
            scope = 'release-tree' if commit == history.commit else 'pre-existing' if commit in history.public_commits else 'newly-public'
            config_tree, invalid = timings.call('history.context', context, history, commit, config)
            for path in invalid:
                add(INVALID if (project is not None or repository is not None) and path == 'edition.json' else 'scan.identity-invalid', path, commit, scope=scope)
            license_entry = entries_by_commit[commit].get('LICENSE')
            license_oid = license_entry['oid'] if license_entry and license_entry['mode'] in ('100644', '100755') else None
            for rule in license_rules(history.blob(license_oid) if license_oid else None, recorded):
                bucket = 'warnings' if rule == 'license.missing' and public_base and scope == 'newly-public' and release_license_good else None
                add(rule, 'LICENSE', commit, license_oid, scope, bucket)
            signature = (config_tree['declaredSources'], config_tree['projectIdentity'], frozenset(config_tree['trustBundles'].items()))
            for entry in entries:
                path, oid = entry['path'], entry['oid']
                seen_blobs.add(oid)
                if entry['kind'] != 'blob':
                    add('scan.submodule-uninspected', path, commit, oid, scope)
                    continue
                pair = (path, oid)
                if pair not in dependencies:
                    data = history.blob(oid)
                    dependencies[pair] = local_dependencies(data, path)
                local = dependencies[pair] & config_tree['localPaths']
                key = (path, oid, signature, local)
                if key not in inspected:
                    inspected[key] = timings.call('history.text', text_rules, history.blob(oid), path, config_tree, hashes)
                rules, provenance, references = inspected[key]
                entry_scope = 'pre-existing' if (scope != 'release-tree' and oid in public_blobs) or public_paths.get(path) == oid else scope
                for rule in rules:
                    add(rule, path, commit, oid, entry_scope)
                if references:
                    deferred.append((references, path, commit, oid, entry_scope))
                if provenance:
                    add('provenance.declared-source', path, commit, oid, entry_scope)
        report['history'].update(commits=len(history.commits), trees=len(seen_trees), blobs=len(seen_blobs))
        selected_context, _ = timings.call('working-tree.context', context, history, history.commit, config)
        working_paths = []
        working_identities = {}
        for path, data in working_files(Path(history.repo)):
            working_paths.append(path)
            target = Path(history.repo) / path
            if identity_candidate(path) and not any(p.is_symlink() for p in [target, *target.parents]):
                working_identities[path] = data
            # Native hash-object is unnecessary here: unchanged current bytes use
            # their known immutable identity; new bytes have no history identity.
            entry = entries_by_commit[history.commit].get(path)
            oid = entry['oid'] if entry and entry['kind'] == 'blob' and history.blob(entry['oid']) == data else None
            rules, _, references = timings.call('working-tree.text', text_rules, data, path, selected_context, hashes)
            public_oid = public_paths.get(path)
            scope = 'pre-existing' if public_oid and (public_oid == oid or history.blob(public_oid) == data) else 'working-tree'
            for rule in rules:
                add(rule, path, history.commit, oid, scope)
            if references:
                deferred.append((references, path, history.commit, oid, scope))
            if path == 'LICENSE':
                for rule in license_rules(data, recorded):
                    add(rule, path, history.commit, oid, 'working-tree')
        if not (Path(history.repo) / 'LICENSE').is_file():
            add('license.missing', 'LICENSE', scope='working-tree')
        identities = {'working-tree': timings.call('identities.prepare', ContentIdentities, working_identities,
            lambda path: working_regular(Path(history.repo), path))}
        checksums = {}
        for mode in ('git', 'dir'):
            for hit in timings.call('gitleaks.' + mode, secrets, binary, mode, history.repo, history.revisions, timeout=timeout, redact=False):
                path, commit = hit.get('File', '.'), hit.get('Commit') or history.commit
                if mode == 'dir' and Path(path).is_absolute():
                    path = Path(path).resolve().relative_to(Path(history.repo).resolve()).as_posix()
                entry = entries_by_commit.get(commit, {}).get(path)
                oid = entry['oid'] if entry and entry['kind'] == 'blob' else None
                if mode == 'dir':
                    public_oid = public_paths.get(path)
                    held = working_regular(Path(history.repo), path) if public_oid else None
                    scope = 'pre-existing' if held and history.blob(public_oid) == held[0] else 'working-tree'
                else:
                    scope = 'pre-existing' if (oid and public_paths.get(path) == oid) or (commit != history.commit and oid in public_blobs) else 'release-tree' if commit == history.commit else 'newly-public'
                if hit['RuleID'] in ('generic-api-key', 'hex-api-key'):
                    identity_scope = 'working-tree' if mode == 'dir' else commit
                    scoped_entries = entries_by_commit.get(commit, {})
                    def read_regular(path, scoped_entries=scoped_entries):
                        entry = scoped_entries.get(path)
                        return (history.blob(entry['oid']), entry['mode']) if entry and entry['kind'] == 'blob' and entry['mode'] in ('100644', '100755') else None
                    if identity_scope not in checksums:
                        checksums[identity_scope] = timings.call('checksums.prepare', ChecksumMaps,
                            working_paths if mode == 'dir' else scoped_entries,
                            (lambda path: working_regular(Path(history.repo), path)) if mode == 'dir' else read_regular)
                    if identity_candidate(path):
                        if identity_scope not in identities:
                            identities[identity_scope] = timings.call('identities.prepare', ContentIdentities, {
                                p: history.blob(e['oid']) for p, e in scoped_entries.items()
                                if identity_candidate(p) and e['kind'] == 'blob' and e['mode'] in ('100644', '100755')}, read_regular)
                        if identities[identity_scope].matches(path, hit):
                            continue
                    else:
                        # Identity documents use their own exact structural locations.
                        held = working_regular(Path(history.repo), path) if mode == 'dir' else read_regular(path)
                        if held and checksums[identity_scope].matches(held[0], hit):
                            continue
                add(secret_rule(hit['RuleID']), path, commit, oid, scope, scanner_rule=hit['RuleID'])
        messages, lines = [], []
        count = 1
        all_paths = dict.fromkeys(working_paths, history.commit)
        for commit, entries in entries_by_commit.items():
            for path in entries:
                all_paths.setdefault(path, commit)
        for path, commit in sorted(all_paths.items()):
            data = path.encode('utf-8', 'surrogateescape') + b'\n'
            messages.append(data)
            length = data.count(b'\n')
            scope = 'working-tree' if path in working_paths else 'pre-existing' if commit in history.public_commits else 'newly-public'
            lines.append((count, count + length, path, commit, scope))
            count += length
        for message_type, commit, data in staged_annotation.messages(history, staged):
            path = '@' + message_type + '-message'
            report['history']['tagMessages' if message_type == 'tag' else 'commitMessages'] += 1
            rules, _, references = timings.call('messages.text', text_rules, data, path, selected_context, hashes,
                                              commit_message=message_type == 'commit')
            scope = 'pre-existing' if commit in history.public_commits or commit in history.public_tags else 'release-tree' if commit == history.commit else 'newly-public'
            for rule in rules:
                add(rule, path, commit, scope=scope)
            if references:
                deferred.append((references, path, commit, None, scope))
            messages.append(data + b'\n')
            length = (data + b'\n').count(b'\n')
            lines.append((count, count + length, path, commit, scope))
            count += length
        for hit in timings.call('gitleaks.messages', secrets, binary, 'stdin', data=b''.join(messages), timeout=timeout):
            line = hit.get('StartLine', 0)
            location = next(((p, c, s) for start, end, p, c, s in lines if start <= line < end), ('@message', None, 'newly-public'))
            add(secret_rule(hit['RuleID']), location[0], location[1], scope=location[2], scanner_rule=hit['RuleID'])
        states = timings.call('github.references', GitHubResolver().resolve_all,
                              {repository for references, *_ in deferred for repository, _, _ in references})
        for references, path, commit, oid, scope in deferred:
            for rule in reference_rules(references, states):
                add(rule, path, commit, oid, scope)
    except PublicBaseError:
        add('scan.public-base-rejected', '.')
    except InspectionError as error:
        if str(error).startswith('scan.'):
            add(str(error), '.')
        else:
            add('scan.history-incomplete', '.')
            report['findings'][-1]['reason'] = str(error)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        add('scan.configuration-incomplete', '.')
    finally:
        if history:
            history.close()
        timings.finish()
    finish(report)
    staged_annotation.summary(report, staged)
    return report
