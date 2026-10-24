import { execFileSync } from 'node:child_process';
import { git } from './source.mjs';
import { verifyWorkflow } from './verify-workflow.mjs';

const same = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
function identity(value) {
  if (typeof value !== 'string') return undefined;
  const scp = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(value);
  if (scp) return scp[1];
  try {
    const url = new URL(value.replace(/^git\+/, ''));
    if (url.hostname.toLowerCase() !== 'github.com' || !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.search || url.hash) return undefined;
    return /^\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname)?.[1];
  } catch { return undefined; }
}

export function githubSource(source) {
  const origin = git(source.repo, 'remote').toString().split(/\s+/).includes('origin')
    ? git(source.repo, 'remote', 'get-url', 'origin').toString().trim() : '';
  const declared = source.entries.has('rer-project.json')
    ? JSON.parse(source.bytes('rer-project.json')).sourceRepository : '';
  return identity(origin) ?? identity(declared ?? '');
}

function api(path, paginated = false) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  delete env.GH_DEBUG; delete env.DEBUG;
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com',
    ...(paginated ? ['--paginate', '--slurp'] : []), path],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 }));
}

function tagCommit(repository, tag) {
  let object = api(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`).object;
  // A tag can point at another annotated tag. Bound malformed/cyclic replies.
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) return null;
    object = api(`repos/${repository}/git/tags/${object.sha}`).object;
  }
  return object?.type === 'commit' ? object.sha : null;
}

export function githubVerify(source, repository, selector) {
  const result = { status: 'FAIL', provider: 'github', repository, commit: source.commit,
    reason: 'github-verify-not-successful',
    message: `No successful Verify run exists for ${repository} at exact source commit ${source.commit}. To obtain qualifying evidence, push the exact commit to any branch of ${repository} and wait for its Verify run to complete successfully. Check the run details below. --local-verify runs local verification instead, only when the repository's verification policy permits it.` };
  try {
    const metadata = api(`repos/${repository}`);
    if (!same(metadata.full_name, repository) || typeof metadata.default_branch !== 'string' || !metadata.default_branch) throw Error('repository');
    const workflows = api(`repos/${repository}/actions/workflows?per_page=100`, true)
      .flatMap(page => page.workflows).filter(workflow => Number.isSafeInteger(workflow.id));
    const selected = verifyWorkflow(source, workflows, selector);
    if (selected.error) return { ...result, details: selected.error };
    const workflow = selected.workflow;
    Object.assign(result, { workflowId: workflow.id, workflowFile: workflow.path, workflowName: workflow.name });
    const rejected = new Set(), successful = [], information = [];
    let checkedTag = false, tagSHA, tagUnavailable = false;
    const runs = api(`repos/${repository}/actions/workflows/${workflow.id}/runs?head_sha=${source.commit}&per_page=100`, true)
      .flatMap(page => page.workflow_runs);
    for (const run of runs) {
      if (run.head_sha !== source.commit) { rejected.add('different source SHA'); continue; }
      if (!same(run.repository?.full_name, repository) || !same(run.head_repository?.full_name, repository)) {
        rejected.add('different source repository'); continue;
      }
      if (run.workflow_id !== workflow.id) { rejected.add('different workflow'); continue; }
      if (!['push', 'workflow_dispatch'].includes(run.event)) { rejected.add('event must be push or workflow_dispatch'); continue; }
      const evidence = { runId: run.id, runUrl: `https://github.com/${metadata.full_name}/actions/runs/${run.id}`,
        event: run.event, branch: run.head_branch, conclusion: run.conclusion };
      if (run.status !== 'completed' || run.conclusion !== 'success') {
        const reason = run.status === 'completed'
          ? `conclusion ${['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'stale'].includes(run.conclusion) ? run.conclusion : 'not success'}`
          : `run not completed (${run.status})`;
        rejected.add(`Run ${run.id} on ${run.head_branch} (${run.event}): ${reason}; ${evidence.runUrl}`);
        information.push({ ...evidence, status: run.status,
          message: `${reason}; does not invalidate a separate successful Verify run for this exact SHA.` });
        continue;
      }
      // A push or workflow_dispatch run for this exact SHA ran this commit's
      // own workflow file on this commit's tree, regardless of branch. A
      // pull_request run tests its merge ref and cannot provide that evidence.
      if (run.head_branch === source.tag && run.head_branch !== metadata.default_branch) {
        if (!checkedTag) {
          checkedTag = true;
          try { tagSHA = tagCommit(repository, source.tag); }
          catch { tagUnavailable = true; }
        }
        // A tag lookup failure rejects this run, not independent branch evidence.
        if (tagUnavailable) { rejected.add('release tag could not be resolved'); continue; }
        if (tagSHA !== source.commit) { rejected.add('release tag points at a different commit'); continue; }
      }
      if (!Number.isSafeInteger(run.id) || run.id <= 0) throw Error('run');
      successful.push(evidence);
    }
    // API page order is not an authority: select the highest qualifying run ID.
    successful.sort((left, right) => right.runId - left.runId);
    information.sort((left, right) => right.runId - left.runId);
    if (successful.length) {
      return { status: 'PASS', provider: 'github', repository: metadata.full_name, commit: source.commit,
        workflowId: workflow.id, workflowFile: workflow.path, workflowName: workflow.name,
        ...successful[0], ...(information.length ? { information } : {}) };
    }
    if (tagUnavailable) throw Error('tag');
    result.details = rejected.size ? [...rejected].join('; ') : 'No runs found for this SHA.';
  } catch {
    result.reason = 'github-verify-unavailable';
    result.details = 'GitHub Verify could not be resolved. Check gh authentication and repository access, then try again; no local verification was substituted.';
  }
  return result;
}
