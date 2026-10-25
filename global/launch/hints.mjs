// Preparation failures and legacy dispatcher output use the invocation that
// the person's shell can run. Qualify messages before JSON serialization so
// quoted paths remain valid data.
import { readShellWord } from '../../cli/shell-word.mjs';

function checkoutRanges(text) {
 const flags = / --cwd /g, ranges = [], paths = new Set();
 let match;
 while ((match = flags.exec(text))) {
  const word = readShellWord(text, flags.lastIndex);
  ranges.push([match.index, word.end]); flags.lastIndex = word.end;
  if (word.value.startsWith('/')) paths.add(word.value);
 }
 // Diagnostics also name these same absolute checkouts in prose before their
 // recovery command. Their literal directory names are not commands either.
 for (const path of paths) {
  let start = 0;
  while ((start = text.indexOf(path, start)) >= 0) { ranges.push([start, start + path.length]); start += path.length; }
 }
 return ranges.sort((a, b) => a[0] - b[0]);
}

export function qualifyHints(value, stopHint) {
 if (!stopHint) return value;
 const end = stopHint.indexOf(' dev --stop');
 if (end < 0) return value;
 const invocation = stopHint.slice(0, end);
 if (typeof value === 'string') {
  // Only command introducers are patterns. A cwd is one complete shell word,
  // including adjacent quoted/unquoted segments, kept byte for byte.
  const commands = / --cwd |(?<![\w/.~-])rer (dev|preview) --stop|(?<![\w/.~-])rer (?=(?:dev|preview|setup|open)\b)/g;
  const ranges = checkoutRanges(value);
  let result = '', cursor = 0, match;
  while ((match = commands.exec(value))) {
   const [command, verb] = match;
   result += value.slice(cursor, match.index);
   const range = ranges.find(([start, end]) => start <= match.index && match.index < end);
   if (range) {
    commands.lastIndex = range[1];
    result += value.slice(match.index, commands.lastIndex);
   } else result += verb && !value.startsWith(' --cwd ', commands.lastIndex)
    ? stopHint.replace(' dev --stop', ` ${verb} --stop`)
    : invocation + command.slice(3);
   cursor = commands.lastIndex;
  }
  return result + value.slice(cursor);
 }
 if (Array.isArray(value)) return value.map(item => qualifyHints(item, stopHint));
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, qualifyHints(item, stopHint)]));
 return value;
}
