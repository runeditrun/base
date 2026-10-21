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
  return (query: number[], text: string): SearchResult[] => {
    if (query.length !== index.dimensions || !query.every(Number.isFinite)) throw Error('Invalid query embedding');
    const norm = magnitude(query);
    if (!norm) throw Error('Empty query embedding');
    const evidence = lexical(text);
    const ranked = index.chunks.flatMap((chunk, i) => {
      const semantic = chunk.vector.reduce((sum, value, dimension) => sum + value * query[dimension], 0) / (norm * norms[i]);
      const words = evidence[i];
      // Semantic-only candidates retain a lower floor; lexical candidates need
      // multiple topic words (or the complete heading), not a common product word.
      if (semantic < 0.42 && !(words.score >= 0.35 && words.matched >= words.required && words.required > 0) && !words.exact) return [];
      return [{
        href: chunk.href, titlePath: chunk.titlePath,
        snippet: chunk.text.length > 155 ? `${chunk.text.slice(0, 154).replace(/\s+\S*$/, '')}…` : chunk.text,
        score: 0.55 * semantic + 0.45 * words.score + words.boost,
      }];
    }).sort((a, b) => b.score - a.score || (a.href < b.href ? -1 : a.href > b.href ? 1 : 0) || (a.snippet < b.snippet ? -1 : a.snippet > b.snippet ? 1 : 0));
    const seen = new Set<string>();
    return ranked.filter(result => { if (seen.has(result.href)) return false; seen.add(result.href); return true; }).slice(0, 5);
  };
}
