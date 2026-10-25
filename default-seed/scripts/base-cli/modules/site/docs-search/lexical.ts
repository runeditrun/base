import type { SearchIndex } from './types';

const normalize = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (text: string) => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const phrase = (text: string) => words(text).join(' ');
// Grammatical words do not identify a topic. Other weights come from the corpus.
const stop = new Set('a an and are as at be been being by can could did do does for from had has have how i if in into is it its me my of on or our should that the their them there these they this those to was we were what when where which who why will with would you your'.split(' '));
const terms = (text: string) => [...new Set(words(text).filter(word => !stop.has(word)))];

function affinity(query: string, word: string): number {
  if (query === word) return 1;
  const prefix = query.length >= 4 && word.startsWith(query) ? 0.8 : 0;
  if (Math.min(query.length, word.length) < 4 || Math.abs(query.length - word.length) > 1) return prefix;
  let left = 0;
  while (left < Math.min(query.length, word.length) && query[left] === word[left]) left++;
  if (query.length === word.length) {
    if (query.slice(left + 1) === word.slice(left + 1)) return 0.9;
    if (query[left] === word[left + 1] && query[left + 1] === word[left] && query.slice(left + 2) === word.slice(left + 2)) return 0.9;
  } else {
    const [short, long] = query.length < word.length ? [query, word] : [word, query];
    if (short.slice(left) === long.slice(left + 1)) return 0.9;
  }
  return prefix;
}

/** A published heading is the retrieval unit, even when its paragraphs were
 * embedded separately. No query aliases or additional index/provider. */
export function lexicalEvidence(index: SearchIndex) {
  const headings = new Map<string, { title: string[]; leaf: string[]; body: Set<string>; heading: string }>();
  for (const chunk of index.chunks) {
    const field = headings.get(chunk.href) ?? { title: terms(chunk.titlePath.join(' ')), leaf: terms(chunk.titlePath.at(-1) ?? ''), body: new Set<string>(), heading: phrase(chunk.titlePath.at(-1) ?? '') };
    for (const word of terms(chunk.text)) field.body.add(word);
    headings.set(chunk.href, field);
  }
  const frequency = new Map<string, number>();
  for (const field of headings.values()) for (const word of new Set([...field.title, ...field.body])) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const vocabulary = [...frequency.keys()];
  const idf = (word: string) => Math.log(1 + (headings.size + 0.5) / ((frequency.get(word) ?? 0) + 0.5));
  const candidates = (term: string) => vocabulary.map(word => ({ word, match: affinity(term, word) })).filter(row => row.match);
  // Correct only an unknown spelling with one unambiguous best corpus match.
  // Known words and ambiguous prefixes remain exactly as the visitor typed them.
  const correct = (word: string) => {
    if (frequency.has(word) || stop.has(word)) return word;
    const matches = candidates(word).sort((a, b) => b.match - a.match);
    return matches.length && (!matches[1] || matches[0].match > matches[1].match) ? matches[0].word : word;
  };
  const prepare = (text: string) => {
    const expanded = normalize(text).replace(/[\p{L}\p{N}]+/gu, correct);
    const corrected = expanded.length <= 240 ? expanded : text;
    const topic = terms(corrected);
    return { text: corrected, known: topic.some(term => frequency.has(term) || candidates(term).length > 0) };
  };
  const match = (term: string, field: Iterable<string>) => {
    let best = 0;
    for (const word of field) best = Math.max(best, affinity(term, word));
    return best;
  };
  const score = (text: string) => {
    const query = terms(text), queryPhrase = phrase(text);
    const weighted = query.map(term => {
      // A partial word's weight uses the most frequent matching corpus term;
      // a rare accidental spelling must not dominate the entire query.
      const matches = candidates(term);
      return { term, weight: frequency.has(term) || !matches.length ? idf(term) : Math.min(...matches.map(row => idf(row.word))) };
    });
    const total = weighted.reduce((sum, row) => sum + row.weight, 0) || 1;
    return new Map([...headings].map(([href, field]) => {
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
      return [href, { score: 0.75 * coverage + 0.25 * title, coverage, matched, required: Math.min(2, query.length), exact, boost: exact ? 0.65 : prefix ? 0.12 : 0 }];
    }));
  };
  return { prepare, score };
}
