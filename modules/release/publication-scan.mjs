import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { git } from './source.mjs';
import { annotate } from './export.mjs';
import { runningVersion } from '../../cli/version.mjs';

export function validatePublicationDestination(source, project, repository) {
  try {
    execFileSync('python3', ['-B', resolve(import.meta.dirname, '../../scripts/publish-check/destination.py'),
      '--repo', source.repo, '--ref', source.commit, '--project', project, '--repository', repository],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw Error('Publication destination must agree with the committed edition and project identities'); }
}

export function publicationScan(repo, ref, envFile, project, repository, publicBase, annotationFile) {
  const started = performance.now();
  let report;
  try {
    report = JSON.parse(execFileSync(process.execPath,
      [resolve(import.meta.dirname, '../../scripts/publish-check.mjs'), '--repo', repo, '--ref', ref,
        ...(publicBase ? ['--public-base', publicBase] : []), ...(project != null ? ['--project', project] : []), ...(repository != null ? ['--repository', repository] : []), ...(envFile ? ['--env-file', envFile] : []),
        ...(annotationFile ? ['--annotation-file', annotationFile] : [])],
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
// seed. The scanner sees the original checkout and every source ref; only the
// new annotation is read from the clean candidate, never verification output.
export function sourcePublicationScan(source, temporary, envFile, project, repository, publicBase, tagged, adopted) {
  const started = performance.now();
  let annotationFile;
  if (adopted) {
    annotationFile = resolve(temporary, 'annotation.tag');
    writeFileSync(annotationFile, git(adopted.repo, 'cat-file', 'tag', adopted.object), { mode: 0o600 });
  } else if (tagged) {
    const candidate = resolve(temporary, 'annotation');
    git(source.repo, 'clone', '--no-hardlinks', '--no-checkout', '--', source.repo, candidate);
    git(candidate, 'checkout', '--detach', source.commit);
    const staged = git(candidate, 'tag', '--list', source.tag).toString().trim();
    const name = staged ? `${source.tag}-publication-candidate` : source.tag;
    annotate(candidate, source, source.commit, name);
    annotationFile = resolve(temporary, 'annotation.tag');
    writeFileSync(annotationFile, git(candidate, 'cat-file', 'tag', `refs/tags/${name}`), { mode: 0o600 });
  }
  const stagingSeconds = (performance.now() - started) / 1000;
  const report = publicationScan(source.repo, source.commit, envFile, project, repository, publicBase, annotationFile);
  Object.assign(report.invocation, { stagingSeconds, totalSeconds: (performance.now() - started) / 1000 });
  return report;
}
