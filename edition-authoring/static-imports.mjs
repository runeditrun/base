// Ask the running Node engine to parse a module, without linking or evaluating
// it. The VM flag belongs only to this child, so callers need no special flags.
import {spawnSync} from 'node:child_process';

const parse = `
  const {readFileSync} = require('node:fs');
  const {SourceTextModule} = require('node:vm');
  try {
    const module = new SourceTextModule(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify({specifiers: module.moduleRequests.map(request => request.specifier)}));
  } catch (error) {
    process.stdout.write(JSON.stringify({error: error.message}));
    process.exitCode = 1;
  }
`;

// V8 supplies cooked static import/export specifiers in source order. Dynamic
// import() and import.meta are not module requests. Invalid or unsupported
// module syntax refuses the whole refresh through the caller's planning phase.
export function staticImports(text) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', parse], {
    input: text, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw Error(`Module parser terminated by ${result.signal}`);
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw Error(`Module parser failed (exit ${result.status}): ${result.stderr.trim()}`); }
  if (result.status !== 0) throw Error(response.error || `Module parser failed (exit ${result.status})`);
  return response.specifiers;
}
