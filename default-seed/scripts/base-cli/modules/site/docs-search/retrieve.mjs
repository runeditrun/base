import MiniSearch from './vendor/minisearch.mjs';
import { searchOptions, terms } from './lexical.mjs';

/** Deserialize the build-time index; all queries execute in this browser. */
export function createSearcher(index, expected) {
  if (index?.version !== 2 || typeof index.sourceHash !== 'string'
    || expected && (index.version !== expected.version || index.sourceHash !== expected.sourceHash)) throw Error('Search index version/source mismatch');
  const engine = MiniSearch.loadJS(index.engine, searchOptions);
  return text => {
    if (text.length > 240) return [];
    const query = [...new Set(terms(text))];
    if (!query.length) return [];
    const results = engine.search(text, { boost: { heading: 5, title: 2, path: 1.5, text: 1 },
      prefix: term => term.length >= 4, fuzzy: term => term.length >= 4 ? 0.2 : false, maxFuzzy: 1,
      combineWith: 'OR', weights: { fuzzy: 0.65, prefix: 0.8 } });
    return results.flatMap(row => {
      // Require most topic terms, including unknown words. This rejects a
      // coincidental common word in an otherwise out-of-corpus question.
      const coverage = row.queryTerms.length / query.length;
      if (coverage < 0.6 || row.score < 1.5) return [];
      const leaf = terms(row.titlePath.at(-1) ?? '').join(' ');
      const phrase = query.join(' ');
      const body = terms(row.text).join(' ');
      const exact = leaf === phrase;
      const proximity = body.includes(phrase) || leaf.includes(phrase);
      return [{ href: row.href, titlePath: row.titlePath,
        snippet: row.text.length > 155 ? `${row.text.slice(0, 154).replace(/\s+\S*$/, '')}…` : row.text,
        score: row.score * coverage * coverage * (exact ? 2 : proximity ? 1.25 : 1) }];
    }).sort((a, b) => b.score - a.score || (a.href < b.href ? -1 : a.href > b.href ? 1 : 0)).slice(0, 5);
  };
}
