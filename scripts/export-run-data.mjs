// Keep generated shell/docs copies of the one local-run budget in sync.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coldRunBudget } from '../foundation/runtime/run-data.mjs';
export async function exportRunData(base) {
 for (const name of ['export/RUN-LOCALLY.md', 'global/README.md', 'global/install.sh']) {
  const path = resolve(base, name), source = await readFile(path, 'utf8');
  const shell = name.endsWith('.sh');
  const pattern = shell ? /(# BEGIN COLD RUN BUDGET[^\n]*\n)[\s\S]*?( # END COLD RUN BUDGET)/ : /(<!-- BEGIN COLD RUN BUDGET -->\n)[\s\S]*?(<!-- END COLD RUN BUDGET -->)/;
  if (!pattern.test(source)) throw Error(`Missing budget export markers in ${name}`);
  const content = shell ? ` cold_run_budget='${coldRunBudget.replaceAll("'", "'\\''")}'\n` : coldRunBudget + '\n';
  await writeFile(path, source.replace(pattern, (_, start, end) => start + content + end));
 }
}
if (process.argv[1] === import.meta.filename) await exportRunData(resolve(import.meta.dirname, '..'));
