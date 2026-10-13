// Journey programs live in the installed seed but run against fresh copies
// with no node_modules yet. Resolve the launcher's entry in the journey's own
// checkout, so it can install and dispatch the fresh copy's pin.
import { dirname, join, relative, sep } from 'node:path';

export function rewriteTestLaunches(text, file, scripts = {}) {
 let binding = '__rerTestEntry';
 while (new RegExp(`\\b${binding}(?:Args|Path|Pnpm)?\\b`).test(text)) binding += '_';
 const before = text;
 const isEntry = literal => relative('.', join(dirname(file), literal)).split(sep).join('/') === 'scripts/rer.mjs' || literal === 'scripts/rer.mjs';
 // A URL relative to this test, or a path assembled from the scratch root.
 text = text.replace(/new URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g, (whole, quote, literal) => isEntry(literal) ? `new URL(import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs'))` : whole);
 text = text.replace(/\b(?:join|resolve)\(\s*[^,()\n]+,\s*(['"])((?:\.\/)?scripts\/rer\.mjs)\1\s*\)/g, binding);
 text = text.replace(/(['"])((?:\.{1,2}\/)*scripts\/rer\.mjs)\1/g, (whole, quote, literal) => isEntry(literal) ? binding : whole);
 // README command shims are template strings. Keep the launcher's path in the
 // parent checkout even when the shell's cwd is the disposable app.
 text = text.replace(/\$\{[^}\n]+\}\/scripts\/rer\.mjs/g, '${' + binding + '}');
 // The reference's README journeys run package aliases via pnpm, sometimes
 // under nice. They need the same entry and lifetime as direct node launches.
 // Use the seed's actual dispatcher aliases; keep every other tool command.
 const aliases = Object.fromEntries(Object.entries(scripts).flatMap(([name, command]) => {
  const match = /^(?:node (?:\.\/)?scripts\/rer\.mjs|rer)(?: (\w+))?$/.exec(command);
  return match ? [[name, match[1] ?? '']] : [];
 }));
 let pnpm = false;
 text = text.replace(/(\b[\w$.]+\(\s*)(['"])(pnpm|nice)\2\s*,\s*(\[[^\[\]]*\]|\w+)(?=\s*[,\)])/g, (whole, open, quote, program, args) => {
  if (!Object.keys(aliases).length) return whole;
  const literal = /^\[\s*(['"])([^'"]+)\1/.exec(args)?.[2];
  if (program === 'pnpm' && literal && literal !== 'run' && !Object.hasOwn(aliases, literal)) return whole;
  if (program === 'nice' && !args.includes('...') && !/(['"])pnpm\1/.test(args)) return whole;
  pnpm = true; return `${open}...${binding}Pnpm(${quote}${program}${quote}, ${args})`;
 });
 if (text !== before) text = text.replace(/exec node ([^\n]+?) "\$@"/g, (whole, path, offset) =>
  (!path.includes(binding) && !path.includes('@runeditrun/rer/internal/global/rer.mjs')) || text.slice(Math.max(0, offset - 120), offset).includes('--foreground') ? whole : `if [ "$1" = dev ]; then case " $* " in *" --foreground "*|*" --detach "*|*" --stop "*|*" --help "*) ;; *) set -- "$@" --foreground ;; esac; fi\\nexec node ${path} "$@"`);
 // Wrap only argv whose first element is the rer entry, including helper
 // launches such as [entry, ...args]. Vite/Wrangler dev argv and lists of
 // modes must keep their own arguments. Resolve aliases from their assignment,
 // rather than relying on a particular name for the journey's entry variable.
 const launchers = new Set([binding]);
 for (const match of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]+)/g)) {
  if (match[2].includes('@runeditrun/rer/internal/global/rer.mjs') || new RegExp(`\\b${binding}\\b`).test(match[2])) launchers.add(match[1]);
 }
 const needsEntry = pnpm || new RegExp(`\\b${binding}\\b`).test(text);
 let wrapped = false;
 const first = new RegExp(`^\\s*(?:${[...launchers].join('|')})\\s*(?:,|$)`);
 text = text.replace(/\[([^\[\]]*)\]/g, (whole, content) => {
  if (!first.test(content)) return whole;
  wrapped = true; return `${binding}Args(${whole})`;
 });
 if (needsEntry || wrapped) {
  const declaration = (needsEntry ? `import { fileURLToPath as ${binding}Path } from 'node:url';\nconst ${binding} = ${binding}Path(import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs'));\n` : '') +
   (wrapped || pnpm ? `const ${binding}Args = args => args[1] === 'dev' && !args.some(arg => ['--foreground', '--detach', '--stop', '--help'].includes(arg)) ? [...args, '--foreground'] : args;\n` : '') +
   (pnpm ? `const ${binding}Pnpm = (program, args) => {\n const at = program === 'nice' ? args.indexOf('pnpm') : -1;\n if (program === 'nice' && at < 0) return [program, args];\n const command = at < 0 ? args : args.slice(at + 1), offset = command[0] === 'run' ? 1 : 0;\n const aliases = ${JSON.stringify(aliases)}, alias = command[offset];\n if (!Object.hasOwn(aliases, alias)) return [program, args];\n const forwarded = command.slice(offset + 1); if (forwarded[0] === '--') forwarded.shift();\n const launch = ${binding}Args([${binding}, ...(aliases[alias] ? [aliases[alias]] : []), ...forwarded]);\n return at < 0 ? [process.execPath, launch] : [program, [...args.slice(0, at), process.execPath, ...launch]];\n};\n` : '');
  const shebang = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
  text = text.slice(0, shebang) + declaration + text.slice(shebang);
 }
 return { text, changed: text !== before };
}
