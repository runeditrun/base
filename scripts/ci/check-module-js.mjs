import path from 'node:path';
import ts from '../../default-seed/node_modules/typescript/lib/typescript.js';
import { testSource } from '../../composition/git-source.mjs';

// Untyped JavaScript gets the same unused/fallthrough checks as module
// TypeScript, without claiming a full typecheck of inferred JavaScript types.
const configPath = path.resolve('default-seed/tsconfig.seed-copies.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const formatHost = {
  getCanonicalFileName: file => file,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};
function report(diagnostics) {
  if (!diagnostics.length) return;
  process.stderr.write(ts.formatDiagnostics(diagnostics, formatHost));
  process.exitCode = 1;
}

if (config.error) {
  report([config.error]);
} else {
  const parsed = ts.parseJsonConfigFileContent({
    ...config.config,
    include: ['../modules/**/*.mjs'],
  }, ts.sys, path.dirname(configPath), { allowJs: true, checkJs: true });
  if (parsed.errors.length) {
    report(parsed.errors);
  } else {
    const sources = parsed.fileNames.filter(file => !testSource(path.relative(process.cwd(), file).split(path.sep).join('/')));
    const program = ts.createProgram(sources, parsed.options);
    // TS6133/6138/6192/6196/6198/6199/6205 are unused declarations;
    // TS7029 is switch fallthrough. Keep syntax errors too.
    const lintCodes = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7029]);
    const files = sources.map(file => program.getSourceFile(file));
    report(files.flatMap(file => [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file).filter(diagnostic => lintCodes.has(diagnostic.code)),
    ]));
    if (!process.exitCode) console.log(`Checked ${files.length} module JavaScript files for syntax, unused declarations and switch fallthrough.`);
  }
}
