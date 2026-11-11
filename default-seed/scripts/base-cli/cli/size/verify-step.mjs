import '../sqlite-notice.mjs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RerError } from '../errors.mjs';
import { measureSize } from './command.mjs';

const join = names => names.join(', ');

// What failed, by name, for the error that fails verify. The lines that explain it were already reported as they ran.
function failureText({ statements, size = {}, flows = [] }) {
  const parts = [];
  const refused = statements.filter(statement => !statement.ok);
  if (refused.length) parts.push(`D1 would refuse the build's schema objects ${join(refused.map(statement => statement.name))}`);
  for (const name of ['small', 'large']) if (size[name]?.error) parts.push(`the ${name} size did not build: ${size[name].error}`);
  const failing = flows.filter(flow => !flow.ok);
  if (failing.length) parts.push(`${failing.length} of ${flows.length} declared flows fail: ${join(failing.map(flow => `${flow.name} (${[...new Set(flow.failures.map(failure => failure.rule))].join(', ')})`))}`);
  return `Size check failed: ${parts.join('; ')}. Run rer size for the full report.`;
}

/**
 * The last step of rer verify: `rer size`, in verify's own job-queue slot. Every view and trigger statement of each D1
 * binding's migrations is measured; with a size-check.json at the checkout root the declared shape is also built at a
 * small and a large size and every declared flow run on each. A failure fails verify, naming the statement or the flow.
 * Resolves what `rer size --json` carries, so verify's result carries it as `size`.
 */
export async function checkSizeStep(root, { report = () => {} } = {}) {
  const { ok, details } = await measureSize({ cwd: root, json: false }, { human: report });
  if (!ok) throw new RerError('size_check_failed', failureText(details), 1);
  return details;
}

if (process.argv[1] && await realpath(new URL(import.meta.url)) === await realpath(process.argv[1])) {
  try { console.log(JSON.stringify(await checkSizeStep(resolve(process.argv[2] ?? '.'), { report: line => console.error(line) }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
