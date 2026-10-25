// Parse in the running Node engine, without linking or evaluating. Flags and
// internal API access are confined to this child; callers need no VM flags.
import {spawnSync} from 'node:child_process';

const parse = `
  const {readFileSync} = require('node:fs');
  const {SourceTextModule, compileFunction} = require('node:vm');
  const {pathToFileURL} = require('node:url');
  const {extname} = require('node:path');
  let nativeParsing = true;
  try {
    const bytes = readFileSync(0), text = bytes.toString('utf8');
    const filename = process.argv[2], url = pathToFileURL('/' + filename).href;
    let format = process.argv[1];
    if (extname(filename) === '' && format !== 'commonjs' && bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
      throw SyntaxError('WebAssembly imports are unsupported by the static JavaScript closure');
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
    nativeParsing = false;
    const requires = [];
    if (process.argv[3] === 'requires') {
      const {parse} = require('internal/deps/acorn/acorn/dist/acorn');
      const input = format === 'commonjs'
        ? '(function(exports,require,module,__filename,__dirname){\\n' + text.replace(/^#![^\\r\\n]*/, '') + '\\n})'
        : text;
      const tree = parse(input, {ecmaVersion: 'latest', sourceType: format === 'module' ? 'module' : 'script'});
      const pending = [tree];
      while (pending.length) {
        const node = pending.pop();
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
            node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') requires.push(node.arguments[0].value);
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) pending.push(...value.filter(item => item && typeof item.type === 'string'));
          else if (value && typeof value.type === 'string') pending.push(value);
        }
      }
    }
    process.stdout.write(JSON.stringify({specifiers, requires}));
  } catch (error) {
    process.stdout.write(JSON.stringify({error: error.message, syntax: nativeParsing && error instanceof SyntaxError}));
    process.exitCode = 1;
  }
`;

// V8 supplies cooked ESM import/export specifiers in source order. CommonJS
// has no static ESM requests: require() and import() are runtime dependencies.
export function staticImports(text, format = 'module', filename = 'source.mjs') {
  return moduleRequests(text, format, filename).specifiers;
}

export function moduleRequests(text, format, filename, entrySignals = false) {
  const result = spawnSync(process.execPath, ['--expose-internals', '--experimental-vm-modules', '--no-warnings', '-e', parse, format, filename, ...(entrySignals ? ['requires'] : [])], {
    input: text, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw Error(`Module parser terminated by ${result.signal}`);
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw Error(`Module parser failed (exit ${result.status}): ${result.stderr.trim()}`); }
  if (result.status !== 0) throw new (response.syntax ? SyntaxError : Error)(response.error || `Module parser failed (exit ${result.status})`);
  return response;
}
