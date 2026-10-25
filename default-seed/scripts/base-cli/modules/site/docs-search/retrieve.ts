import type { SearchIndex, SearchResult } from './types';
import { lexicalEvidence } from './lexical';

const magnitude = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

/** Compile corpus-only statistics once, alongside the version-bound vectors. */
export function createSearcher(index: SearchIndex) {
  const lexical = lexicalEvidence(index);
  const norms = index.chunks.map(chunk => {
    if (chunk.vector.length !== index.dimensions || !chunk.vector.every(Number.isFinite)) throw Error('Invalid search embedding');
    const norm = magnitude(chunk.vector);
    if (!norm) throw Error('Empty search embedding');
    return norm;
  });
  const search = (query: number[], text: string): SearchResult[] => {
    if (query.length !== index.dimensions || !query.every(Number.isFinite)) throw Error('Invalid query embedding');
    const norm = magnitude(query);
    if (!norm) throw Error('Empty query embedding');
    const evidence = lexical.score(text);
    const ranked = index.chunks.flatMap((chunk, i) => {
      const semantic = chunk.vector.reduce((sum, value, dimension) => sum + value * query[dimension], 0) / (norm * norms[i]);
      const words = evidence.get(chunk.href)!;
      // Weak semantic similarities need strong topic coverage. A common word
      // alone cannot rescue an unrelated passage. Exact headings remain direct.
      const precise = words.required > 0 && words.matched >= words.required && words.coverage >= 0.6;
      if (semantic < 0.5 && !precise && !words.exact) return [];
      return [{
        href: chunk.href, titlePath: chunk.titlePath,
        snippet: chunk.text.length > 155 ? `${chunk.text.slice(0, 154).replace(/\s+\S*$/, '')}…` : chunk.text,
        // Preserve semantic ordering among paraphrases; bounded lexical evidence
        // assists it rather than replacing almost half of its signal.
        score: semantic + 0.16 * words.score ** 2 + words.boost,
      }];
    }).sort((a, b) => b.score - a.score || (a.href < b.href ? -1 : a.href > b.href ? 1 : 0) || (a.snippet < b.snippet ? -1 : a.snippet > b.snippet ? 1 : 0));
    const seen = new Set<string>();
    return ranked.filter(result => { if (seen.has(result.href)) return false; seen.add(result.href); return true; }).slice(0, 5);
  };
  return Object.assign(search, { prepareQuery: lexical.prepare });
}
