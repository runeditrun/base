// Literal POSIX shell words used in recovery commands. Reading never executes
// expansions: it returns the decoded literal and its original source boundary.
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function readShellWord(text, start = 0) {
 let value = '', quote, end = start;
 for (; end < text.length; end++) {
  const character = text[end];
  if (!quote && /[ \t\n;&|<>()]/.test(character)) break;
  if (character === quote) { quote = undefined; continue; }
  if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
  if (character === '\\' && quote !== "'") {
   const next = text[end + 1];
   if (next !== undefined && (!quote || /[$`"\\\n]/.test(next))) {
    end++; if (next !== '\n') value += next;
    continue;
   }
  }
  value += character;
 }
 return { value, end };
}
