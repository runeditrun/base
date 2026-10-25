// Parse in the running Node engine, without linking or evaluating. Flags and
// internal API access are confined to this child; callers need no VM flags.
import {spawnSync} from 'node:child_process';

const parse = `
  const {readFileSync} = require('node:fs');
  const {SourceTextModule, compileFunction} = require('node:vm');
  const {pathToFileURL} = require('node:url');
  const {extname} = require('node:path');
  try {
    const bytes = readFileSync(0), text = bytes.toString('utf8');
    const filename = process.argv[2], url = pathToFileURL('/' + filename).href;
    let format = process.argv[1];
    if (extname(filename) === '' && format !== 'commonjs' && bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
      throw Error('WebAssembly imports are unsupported by the static JavaScript closure');
    }
    if (format === 'auto') {
      // Use Node's own ambiguity detector, including lexical redeclarations of
      // wrapper parameters. Do not infer format from regexes or parser errors.
      const {internalBinding} = require('internal/test/binding');
      format = internalBinding('contextify').containsModuleSyntax(text, filename, url) ? 'module' : 'commonjs';
    }
    let specifiers = [];
    if (format === 'commonjs') {
      compileFunction(text, ['exports', 'require', 'module', '__filename', '__dirname'], {filename});
    } else if (format === 'module') {
      const module = new SourceTextModule(new TextDecoder().decode(bytes), {identifier: url});
      specifiers = module.moduleRequests.map(request => request.specifier);
    } else throw Error('Unknown JavaScript format: ' + format);
    process.stdout.write(JSON.stringify({specifiers}));
  } catch (error) {
    process.stdout.write(JSON.stringify({error: error.message}));
    process.exitCode = 1;
  }
`;

// V8 supplies cooked ESM import/export specifiers in source order. CommonJS
// has no static ESM requests: require() and import() are runtime dependencies.
export function staticImports(text, format = 'module', filename = 'source.mjs') {
  const result = spawnSync(process.execPath, ['--expose-internals', '--experimental-vm-modules', '--no-warnings', '-e', parse, format, filename], {
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
