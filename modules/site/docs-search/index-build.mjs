import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import MiniSearch from './vendor/minisearch.mjs';
import { searchOptions } from './lexical.mjs';

export const indexVersion = 2;
export const indexAsset = '/docs-search-index.json';
export const sizeBudget = { bytes: 2_000_000, gzipBytes: 500_000 };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The renderer supplies sections after assigning the published heading ids. */
export function searchDocuments(pages) {
  return pages.flatMap(page => page.searchSections.map(section => {
    const href = `${page.href}#${section.anchor}`;
    return { id: href, href, heading: section.titlePath.at(-1), title: section.titlePath.slice(0, -1).join(' '),
      titlePath: section.titlePath, path: page.href.replace(/[/_-]/g, ' '), text: section.text,
      hash: digest(JSON.stringify([href, section.titlePath, section.text])) };
  })).sort((a, b) => a.href < b.href ? -1 : a.href > b.href ? 1 : 0);
}

export function buildSearchIndex(pages, { previous } = {}) {
  const started = performance.now();
  const documents = searchDocuments(pages);
  if (!documents.length || new Set(documents.map(row => row.id)).size !== documents.length) throw Error('Search requires unique published heading sections.');
  const sourceHash = digest(JSON.stringify(documents));
  const engine = new MiniSearch(searchOptions);
  // Paragraphs are retrieval units so a short task in a long guide remains
  // visible. Every part still navigates to its original published heading.
  const passages = documents.flatMap(doc => doc.text.split(/\n\s*\n/).filter(Boolean).flatMap(paragraph => {
    const parts = paragraph.match(/[\s\S]{1,900}(?:\s|$)|[\s\S]{1,900}/g) ?? [];
    return parts.map(text => ({ ...doc, text: text.trim() }));
  }).map((doc, position) => ({ ...doc, id: String(position) })));
  engine.addAll(passages);
  const index = { version: indexVersion, sourceHash, engine: engine.toJSON() };
  const bytes = JSON.stringify(index);
  const counts = { total: documents.length, reused: 0, reindexed: 0, bytes: Buffer.byteLength(bytes), gzipBytes: gzipSync(bytes).length };
  if (counts.bytes > sizeBudget.bytes || counts.gzipBytes > sizeBudget.gzipBytes) throw Error(`Docs search index exceeds budget (${counts.bytes}/${sizeBudget.bytes} bytes; ${counts.gzipBytes}/${sizeBudget.gzipBytes} gzip bytes).`);
  const old = new Map(Object.values(previous?.version === indexVersion ? previous.engine.storedFields : {}).map(row => [row.href, row.hash]));
  counts.reused = documents.filter(row => old.get(row.href) === row.hash).length;
  counts.reindexed = counts.total - counts.reused;
  return { index, bytes, counts, elapsedMs: performance.now() - started, assetHash: digest(bytes) };
}
