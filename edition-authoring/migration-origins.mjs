import vm from 'node:vm';

// Read the initializer's declarative array in both released (inline copies)
// and current (shared migrationCopies) source. Never execute initialization.
// A refactor outside this declarative shape must update the guard explicitly.
export function migrationMappings(source) {
  const match = /\bexport\s+const\s+migrationCopies\s*=\s*(\[)/.exec(source) ?? /\bcopies:\s*(\[)/.exec(source);
  if (!match) throw Error('Cannot locate initializer migration mappings.');
  const start = match.index + match[0].lastIndexOf('[');
  let depth = 0, quote = null, comment = null, end;
  for (let i = start; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment === 'line') { if (c === '\n') comment = null; continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = null; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (['"', "'", '`'].includes(c)) { quote = c; continue; }
    if (c === '[') depth++;
    if (c === ']' && --depth === 0) { end = i + 1; break; }
  }
  if (!end) throw Error('Unclosed initializer migration mappings.');
  // Legacy copies also include CLI and family maps; these have no migration
  // targets. The static placeholders let us read that same committed array.
  const copies = vm.runInNewContext(`(${source.slice(start, end)})`, {
    sourceRoots: [], family: 'family', edition: 'edition',
  }, {timeout: 1000});
  if (!Array.isArray(copies)) throw Error('Invalid initializer copy mappings.');
  const migrations = copies.filter(copy => typeof copy.target === 'string' && /(?:^|\/)migrations\//.test(copy.target));
  if (!migrations.length || migrations.some(copy => copy.repository !== 'base' || typeof copy.source !== 'string')) throw Error('Initializer migration mapping is unavailable.');
  return migrations;
}
