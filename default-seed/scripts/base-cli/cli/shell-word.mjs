// Literal POSIX shell words used in recovery commands. Reading never executes
// expansions: it returns the decoded literal and its original source boundary.
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function readShellWord(text, start = 0) {
 let value = '', quote, trailingEscape = false, end = start;
 for (; end < text.length; end++) {
  const character = text[end];
  if (!quote && /[ \t\n;&|<>()]/.test(character)) break;
  if (character === quote) { quote = undefined; continue; }
  if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
  if (character === '\\' && quote !== "'") {
   const next = text[end + 1];
   if (next === undefined) trailingEscape = true;
   if (next !== undefined && (!quote || /[$`"\\\n]/.test(next))) {
    end++; if (next !== '\n') value += next;
    continue;
   }
  }
  value += character;
 }
 return { value, end, complete: !quote && !trailingEscape };
}

// Read a command's words, never diagnostic prose. Newlines separate records
// except inside a quoted word, where the literal newline belongs to the word.
export function readShellWords(text, start = 0) {
 const words = [];
 while (start < text.length) {
  while (text[start] === ' ' || text[start] === '\t') start++;
  const word = readShellWord(text, start);
  if (word.end === start || !word.complete) break;
  words.push({ ...word, start }); start = word.end;
 }
 return words;
}
