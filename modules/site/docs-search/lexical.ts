import type { SearchIndex } from './types';

const normalize = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (text: string) => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const phrase = (text: string) => words(text).join(' ');
// Grammatical words carry no topic evidence. Corpus IDF weights all other words.
const stop = new Set('a an and are as at be by can do does for from how i if in is it my of on or that the this to with your'.split(' '));
const terms = (text: string) => [...new Set(words(text).filter(word => !stop.has(word)))];

// One edit (including a transposition), or a typed prefix, at useful lengths.
function affinity(query: string, word: string): number {
  if (query === word) return 1;
  if (query.length >= 4 && word.startsWith(query)) return 0.8;
  if (Math.min(query.length, word.length) < 4 || Math.abs(query.length - word.length) > 1) return 0;
  let left = 0;
  while (query[left] === word[left] && left < Math.min(query.length, word.length)) left++;
  if (query.length === word.length) {
    if (query.slice(left + 1) === word.slice(left + 1)) return 0.75;
    if (query[left] === word[left + 1] && query[left + 1] === word[left] && query.slice(left + 2) === word.slice(left + 2)) return 0.75;
  } else {
    const [short, long] = query.length < word.length ? [query, word] : [word, query];
    if (short.slice(left) === long.slice(left + 1)) return 0.75;
  }
  return 0;
}

/** Statistics belong to published headings, so long multi-chunk guides do not
 * make their own topic words look artificially common. No corpus aliases. */
export function lexicalEvidence(index: SearchIndex) {
  const headings = new Map<string, Set<string>>();
  const fields = index.chunks.map(chunk => {
    const title = terms(chunk.titlePath.join(' ')), leaf = terms(chunk.titlePath.at(-1) ?? ''), body = terms(chunk.text);
    const document = headings.get(chunk.href) ?? new Set<string>();
    for (const word of [...title, ...body]) document.add(word);
    headings.set(chunk.href, document);
    return { title, leaf, body, heading: phrase(chunk.titlePath.at(-1) ?? '') };
  });
  const frequency = new Map<string, number>();
  for (const document of headings.values()) for (const word of document) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const idf = (word: string) => Math.log(1 + (headings.size + 0.5) / ((frequency.get(word) ?? 0) + 0.5));
  return (text: string) => {
    const query = terms(text), queryPhrase = phrase(text);
    // Correct a query term's weight using its best corpus spelling, too.
    const weighted = query.map(term => {
      const candidates = [...frequency.keys()].map(word => ({ word, match: affinity(term, word) })).filter(row => row.match);
      const best = candidates.sort((a, b) => b.match - a.match || idf(b.word) - idf(a.word) || a.word.localeCompare(b.word))[0];
      return { term, weight: idf(best?.word ?? term) };
    });
    const total = weighted.reduce((sum, row) => sum + row.weight, 0) || 1;
    const match = (term: string, field: string[]) => field.reduce((best, word) => Math.max(best, affinity(term, word)), 0);
    return fields.map(field => {
      let coverage = 0, title = 0, matched = 0;
      for (const { term, weight } of weighted) {
        const heading = Math.max(match(term, field.leaf), 0.7 * match(term, field.title));
        const evidence = Math.max(heading, match(term, field.body));
        if (evidence) matched++;
        coverage += weight * evidence / total;
        title += weight * heading / total;
      }
      const exact = Boolean(queryPhrase) && field.heading === queryPhrase;
      const prefix = queryPhrase.length >= 4 && field.heading.startsWith(queryPhrase + ' ');
      return { score: 0.75 * coverage + 0.25 * title, matched, required: Math.min(2, query.length), exact, boost: exact ? 0.65 : prefix ? 0.12 : 0 };
    });
  };
}
