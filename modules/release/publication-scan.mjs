import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { git } from './source.mjs';
import { annotate, sourceTree } from './export.mjs';
import { runningVersion } from '../../cli/version.mjs';

export function validatePublicationDestination(source, project, repository) {
  try {
    execFileSync('python3', ['-B', resolve(import.meta.dirname, '../../scripts/publish-check/destination.py'),
      '--repo', source.repo, '--ref', source.commit, '--project', project, '--repository', repository],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.status === 2) throw Error(error.stderr.toString().trim());
    if (error.status === 1) throw Error('Publication destination must agree with the committed edition and project identities');
    throw Error('Publication destination inspection could not run');
  }
}

export function publicationScan(repo, ref, envFile, project, repository, publicBase, annotationFile, scanTimeoutSeconds) {
  const started = performance.now();
  let report;
  try {
    report = JSON.parse(execFileSync(process.execPath,
      [resolve(import.meta.dirname, '../../scripts/publish-check.mjs'), '--repo', repo, '--ref', ref,
        ...(publicBase ? ['--public-base', publicBase] : []), ...(project != null ? ['--project', project] : []), ...(repository != null ? ['--repository', repository] : []), ...(envFile ? ['--env-file', envFile] : []),
        ...(annotationFile ? ['--annotation-file', annotationFile] : []),
        ...(scanTimeoutSeconds === undefined ? [] : ['--timeout-seconds', String(scanTimeoutSeconds)])],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 }));
  } catch (error) {
    try { report = JSON.parse(error.stdout); }
    catch { throw Error('Publication inspection did not produce a report'); }
  }
  report.invocation = { caller: 'release', scans: 1, stagedAnnotation: Boolean(annotationFile), version: runningVersion(),
    seconds: (performance.now() - started) / 1000 };
  return report;
}

// This is the ordinary release gate, also usable without installing/building a
// seed. Materialize raw committed bytes, without checkout filters or export
// attributes, and mirror every source ref for the existing history policy.
// Neither the caller's local files nor verification output enters this tree.
export function sourcePublicationScan(source, temporary, envFile, project, repository, publicBase, tagged, adopted, scanTimeoutSeconds) {
  const started = performance.now();
  const candidate = sourceTree(source, resolve(temporary, 'publication'));
  git(source.repo, 'clone', '--mirror', '--no-hardlinks', '--', source.repo, resolve(candidate, '.git'));
  git(candidate, 'config', 'core.bare', 'false');
  git(candidate, 'update-ref', '--no-deref', 'HEAD', source.commit);
  git(candidate, 'read-tree', source.commit);
  let annotationFile;
  if (adopted) {
    annotationFile = resolve(temporary, 'annotation.tag');
    writeFileSync(annotationFile, git(adopted.repo, 'cat-file', 'tag', adopted.object), { mode: 0o600 });
  } else if (tagged) {
    const staged = git(candidate, 'tag', '--list', source.tag).toString().trim();
    const name = staged ? `${source.tag}-publication-candidate` : source.tag;
    annotate(candidate, source, source.commit, name);
    annotationFile = resolve(temporary, 'annotation.tag');
    writeFileSync(annotationFile, git(candidate, 'cat-file', 'tag', `refs/tags/${name}`), { mode: 0o600 });
    // Inspect the new tag once via annotationFile, leaving the mirrored source
    // refs unchanged for the full-history scan.
    git(candidate, 'tag', '-d', name);
  }
  const stagingSeconds = (performance.now() - started) / 1000;
  const report = publicationScan(candidate, source.commit, envFile, project, repository, publicBase, annotationFile, scanTimeoutSeconds);
  Object.assign(report.invocation, { stagingSeconds, totalSeconds: (performance.now() - started) / 1000 });
  return report;
}
