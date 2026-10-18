import { workflowName } from './workflow-name.mjs';

const same = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
const filename = path => typeof path === 'string' ? path.split('/').at(-1) : undefined;
const describe = workflow => `${workflow.name ?? "unnamed"} (${workflow.path ?? 'file unknown'})`;

// A selector is authoritative: a typo must never silently choose another gate.
export function verifyWorkflow(source, workflows, override) {
  const declared = override === undefined && source.entries.has('rer-project.json')
    ? JSON.parse(source.bytes('rer-project.json')).verifyWorkflow : undefined;
  const selector = override ?? declared;
  // Tree membership and names come only from inspectSource's pinned commit.
  // The current list supplies an id for the fast, workflow-specific query.
  const committed = [...source.entries].filter(([path, entry]) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path) && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode))
    .map(([path]) => ({ path, name: workflowName(source.bytes(path)) }));
  let matches;
  if (selector !== undefined) {
    if (typeof selector !== 'string' || !selector.trim()) {
      return { error: 'verifyWorkflow must be a nonempty workflow name or file; use --verify-workflow <name|file>.' };
    }
    const file = /\.ya?ml$/i.test(selector) || selector.startsWith('.github/workflows/');
    matches = committed.filter(workflow => file
      ? same(workflow.path, selector) || same(filename(workflow.path), selector)
      : same(workflow.name, selector));
  } else {
    matches = committed.filter(workflow => ['.github/workflows/verify.yml', '.github/workflows/verify.yaml'].some(path => same(workflow.path, path)));
    if (!matches.length) matches = committed.filter(workflow => same(workflow.name, 'verify'));
  }
  if (matches.length === 1) {
    const workflow = matches[0];
    const current = workflows.filter(candidate => candidate.path === workflow.path);
    return { workflow: { ...workflow, ...(current.length === 1 ? { id: current[0].id } : {}) } };
  }
  if (matches.length > 1) return { error: `Ambiguous Verify workflows: ${matches.map(describe).join('; ')}. Select one with --verify-workflow <name|file>.` };
  return { error: `${selector === undefined ? 'No Verify workflow found' : `No Verify workflow matches ${JSON.stringify(selector)}`}. Select a workflow with --verify-workflow <name|file>.` };
}
