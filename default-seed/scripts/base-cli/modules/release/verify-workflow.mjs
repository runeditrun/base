const same = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
const filename = path => typeof path === 'string' ? path.split('/').at(-1) : undefined;
const describe = workflow => `${workflow.name} (${workflow.path ?? 'file unknown'})`;

// A selector is authoritative: a typo must never silently choose another gate.
export function verifyWorkflow(source, workflows, override) {
  const declared = override === undefined && source.entries.has('rer-project.json')
    ? JSON.parse(source.bytes('rer-project.json')).verifyWorkflow : undefined;
  const selector = override ?? declared;
  let matches;
  if (selector !== undefined) {
    if (typeof selector !== 'string' || !selector.trim()) {
      return { error: 'verifyWorkflow must be a nonempty workflow name or file; use --verify-workflow <name|file>.' };
    }
    matches = workflows.filter(workflow => same(workflow.name, selector) || same(workflow.path, selector) || same(filename(workflow.path), selector));
  } else {
    matches = workflows.filter(workflow => ['.github/workflows/verify.yml', '.github/workflows/verify.yaml'].some(path => same(workflow.path, path)));
    if (!matches.length) matches = workflows.filter(workflow => same(workflow.name, 'verify'));
  }
  if (matches.length === 1) return { workflow: matches[0] };
  if (matches.length > 1) return { error: `Ambiguous Verify workflows: ${matches.map(describe).join('; ')}. Select one with --verify-workflow <name|file>.` };
  return { error: `${selector === undefined ? 'No Verify workflow found' : `No Verify workflow matches ${JSON.stringify(selector)}`}. Select a workflow with --verify-workflow <name|file>.` };
}
