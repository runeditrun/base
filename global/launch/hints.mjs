// Preparation failures and legacy dispatcher output use the invocation that
// the person's shell can run. Qualify before JSON serialization: a quoted
// checkout is one literal shell word, even when it contains command words.
import { readShellWords } from '../../cli/shell-word.mjs';

const contains = (ranges, offset) => ranges.some(([start, end]) => start <= offset && offset < end);
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function commandHints(text, invocation) {
 // Discover commands, never raw --cwd fragments in prose. Each candidate is
 // read independently so a quote in an earlier prose label cannot consume it.
 const introducers = new RegExp(`(?<![\\w/.~'-])(${escapePattern(invocation)}|rer) (dev|preview|setup|open)\\b`, 'g');
 const commands = [], paths = new Set();
 for (const match of text.matchAll(introducers)) {
  const start = match.index, executableEnd = start + match[1].length;
  const words = readShellWords(text, executableEnd + 1);
  let cwd;
  for (let index = 1; index < words.length; index++) {
   const word = words[index];
   if (word.value === '--cwd') {
    cwd = words[index + 1];
    if (cwd?.value.startsWith('/')) paths.add(cwd.value);
    break;
   }
   // After the options, an ordinary word is diagnostic prose, not argv.
   if (!word.value.startsWith('--')) break;
  }
  commands.push({ start, executableEnd, verb: match[2], stop: words[1]?.value === '--stop', stopEnd: words[1]?.end, cwd });
 }
 // The formatter also prints the decoded checkout as a prose label. Protect
 // those bytes before considering candidates found inside such a label.
 const prose = [];
 for (const path of paths) {
  let start = 0;
  while ((start = text.indexOf(path, start)) >= 0) { prose.push([start, start + path.length]); start += path.length; }
 }
 const outsideProse = commands.filter(command => !contains(prose, command.start));
 const targets = outsideProse.filter(command => command.cwd).map(command => [command.cwd.start, command.cwd.end]);
 return outsideProse.filter(command => !contains(targets, command.start));
}

export function qualifyHints(value, stopHint) {
 if (!stopHint) return value;
 const words = readShellWords(stopHint);
 const verbIndex = words.findIndex((word, index) => word.value === 'dev' && words[index + 1]?.value === '--stop');
 if (verbIndex < 1) return value;
 const invocation = stopHint.slice(0, words[verbIndex - 1].end);
 if (typeof value === 'string') {
  let result = '', cursor = 0;
  for (const command of commandHints(value, invocation)) {
   if (command.start < cursor) continue;
   result += value.slice(cursor, command.start);
   if (command.stop && !command.cwd) {
    result += stopHint.slice(0, words[verbIndex].start) + command.verb + stopHint.slice(words[verbIndex].end);
    cursor = command.stopEnd;
   } else {
    result += invocation;
    cursor = command.executableEnd;
   }
  }
  return result + value.slice(cursor);
 }
 if (Array.isArray(value)) return value.map(item => qualifyHints(item, stopHint));
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, qualifyHints(item, stopHint)]));
 return value;
}
