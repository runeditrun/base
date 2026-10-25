import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { invalid } from './errors.mjs';
import { contained } from './project.mjs';
import { buildSearchArtifacts } from '../modules/site/docs-search/artifacts.mjs';

// Retained adapter key; this is a static build extension, with assets only.
export function siteRuntime(value) {
 if (value === undefined) return;
 if (!value || Object.keys(value).sort().join() !== 'bindings,corpus,endpoint,module,type' || value.type !== 'docs-search' || value.module !== 'docs-search'
  || JSON.stringify(value.bindings) !== '["ASSETS"]' || value.endpoint !== '/docs-search-index.json'
  || !/^\.rer\/(?:[a-z0-9_-]+\/)+corpus\.json$/.test(value.corpus ?? '')) throw invalid('Run site search must declare { type: "docs-search", module: "docs-search", bindings: ["ASSETS"], endpoint: "/docs-search-index.json", corpus: ".rer/docs-search/corpus.json" }.');
 return value;
}

/** Rendered sections must point to actual published pages and exact heading ids. */
export function searchCorpus(pages, searchPages) {
 if (!Array.isArray(searchPages) || !searchPages.length) throw invalid('A docs-search sitePages() must return searchPages from the same render as its pages.');
 const seen = new Set();
 for (const page of searchPages) {
  const published = pages.find(item => item.path === page?.href);
  if (!published || !(page.href === '/docs' || page.href.startsWith('/docs/')) || !Array.isArray(page.searchSections) || seen.has(page.href)) throw invalid('Docs search corpus must name unique published docs pages.');
  seen.add(page.href);
  for (const section of page.searchSections) {
   if (!section || typeof section.anchor !== 'string' || !section.anchor || !Array.isArray(section.titlePath) || !section.titlePath.length
    || !section.titlePath.every(part => typeof part === 'string' && part.trim()) || typeof section.text !== 'string') throw invalid('Invalid docs search heading section.');
   // Parse the rendered tree, not source Markdown or a second crawl.
   if (!published.ids.has(section.anchor)) throw invalid('Docs search heading is absent from its rendered page.');
  }
 }
 return searchPages;
}

export async function buildSiteRuntime(project, declaration, corpus, assets) {
 const output = await contained(project.root, dirname(declaration.corpus), { optional: true });
 await mkdir(output, { recursive: true });
 const built = await buildSearchArtifacts({ corpus, assets, output });
 const identity = `${built.index.version}:${built.index.sourceHash}:${built.assetHash}`;
 async function stamp(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
   const path = join(folder, item.name);
   if (item.isDirectory()) await stamp(path);
   else if (item.name.endsWith('.html')) {
    const html = await readFile(path, 'utf8');
    if (html.includes('data-docs-search')) {
     if (!/<\/head>/i.test(html)) throw invalid('A docs search page requires a head for its index identity.');
     await writeFile(path, html.replace(/<\/head>/i, `<meta name="docs-search-index" content="${identity}"></head>`));
    }
   }
  }
 }
 await stamp(assets);
 return { type: declaration.type, module: declaration.module, endpoint: declaration.endpoint, bindings: ['ASSETS'],
  indexVersion: built.index.version, corpusHash: built.index.sourceHash, assetHash: built.assetHash, ...built.counts };
}

export const runtimeSummary = runtime => runtime && ({ ...runtime });
