import { clauseIdSource, plainText } from '../../foundation/runtime/seed-contract.mjs';

const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const separator = '\\s+[—–-]\\s+';
const definitions = [
  new RegExp(`^-\\s+\\*\\*(${clauseIdSource})${separator}(.+?)\\*\\*`),
  new RegExp(`^\\*\\*(${clauseIdSource})${separator}(.+?)\\*\\*`),
  new RegExp(`^#{2,6}\\s+(${clauseIdSource})${separator}(.+?)\\s*#*\\s*$`),
];
const cells = text => text.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(plainText);
const excluded = /^(?:Target clauses|Push further|Retired)\b/i;

// Syntax-only extraction for byte-identical inherited contracts. This reads
// their actual prose and optional Kind cells without imposing today's target,
// judgment date, evidence or Status schema on an already released document.
export function historicalClauses(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const clauses = [], kinds = new Map(), sections = [];
  let fence, columns;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) { fence = fence === marker ? undefined : fence ?? marker; continue; }
    if (fence) continue;
    const form = definitions.findIndex(pattern => pattern.test(line));
    const title = heading.exec(line);
    if (title && form !== 2) {
      const level = title[1].length;
      while (sections.at(-1)?.level >= level) sections.pop();
      sections.push({ level, title: plainText(title[2]) });
      columns = undefined;
    }
    if (sections.some(section => /^Status\b/i.test(section.title))) {
      if (line.trimStart().startsWith('|')) {
        const row = cells(line);
        if (row.includes('Clause') && row.includes('Kind')) columns = { clause: row.indexOf('Clause'), kind: row.indexOf('Kind') };
        else if (columns && !row.every(cell => /^:?-*:?$/.test(cell))) {
          const id = row[columns.clause], kind = row[columns.kind];
          if (kinds.has(id) && kinds.get(id) !== kind) throw Error(`CONTRACT.md has conflicting historical Kind cells for ${id}`);
          kinds.set(id, kind);
        }
      }
      continue;
    }
    if (form < 0 || sections.some(section => excluded.test(section.title))) continue;
    const match = definitions[form].exec(line), body = [line.slice(match[0].length)];
    for (let next = index + 1; next < lines.length; next++) {
      const continuation = lines[next];
      if (heading.test(continuation) || definitions.some(pattern => pattern.test(continuation)) ||
        /^\s*(```|~~~)/.test(continuation) || (form === 0 && continuation.trim() && !/^[\t ]/.test(continuation))) break;
      body.push(continuation);
    }
    const clause = { id: match[1], title: plainText(match[2]).replace(/[.:]$/, '').trim(), text: body.join(' ').replace(/\s+/gu, ' ').trim() };
    if (clauses.some(previous => previous.id === clause.id)) throw Error(`CONTRACT.md defines historical clause ${clause.id} twice`);
    clauses.push(clause);
  }
  return clauses.filter(clause => clause.text && (!kinds.has(clause.id) || kinds.get(clause.id) === 'published'));
}
