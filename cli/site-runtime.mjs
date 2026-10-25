// The only executable site extension: Base's build-coupled docs search.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { invalid } from './errors.mjs';
import { contained } from './project.mjs';
import { model, pooling, searchChunks } from '../modules/site/docs-search/index-build.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function siteRuntime(value) {
 if (value === undefined) return;
 if (!value || Object.keys(value).sort().join() !== 'bindings,corpus,endpoint,module,type' || value.type !== 'docs-search' || value.module !== 'docs-search'
  || JSON.stringify(value.bindings) !== '["ASSETS","AI"]' || value.endpoint !== '/docs/search'
  || !/^\.rer\/(?:[a-z0-9_-]+\/)+corpus\.json$/.test(value.corpus ?? '')) throw invalid('Run site runtime must declare { type: "docs-search", module: "docs-search", bindings: ["ASSETS", "AI"], endpoint: "/docs/search", corpus: ".rer/docs-search/corpus.json" }.');
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

export async function buildSiteRuntime(project, declaration, corpus, assets, { prepare = false, redirects = [], domain, compatibilityDate, store, signal } = {}) {
 const pages = JSON.parse(await readFile(corpus, 'utf8'));
 const chunks = searchChunks(pages), corpusHash = digest(chunks.map(chunk => chunk.hash).join('\n'));
 if (prepare) {
  const output = await contained(project.root, dirname(declaration.corpus), { optional: true });
  await store.run('Preparing docs search', process.execPath, [fileURLToPath(new URL('./site-prepare.mjs', import.meta.url)), corpus, assets, output, declaration.endpoint, compatibilityDate, domain], {cwd:project.root, signal, heavy:false});
 }
 const { build } = createRequire(join(project.root, 'package.json'))('esbuild');
 const worker = fileURLToPath(new URL('../modules/site/docs-search/worker.ts', import.meta.url));
 const contract = { endpoint: declaration.endpoint, corpusHash, model, pooling };
 const redirectModule = fileURLToPath(new URL('../modules/deploy-kit/site-redirects.mjs', import.meta.url));
 const entry = redirects.length
  ? `import {createSearchWorker} from ${JSON.stringify(worker)};import {siteRedirectResponse} from ${JSON.stringify(redirectModule)};const search = createSearchWorker(${JSON.stringify(contract)});export default {fetch(request,env){return siteRedirectResponse(request,${JSON.stringify(redirects)}) ?? search.fetch(request,env);}};`
  : `import {createSearchWorker} from ${JSON.stringify(worker)};export default createSearchWorker(${JSON.stringify(contract)});`;
 const bundled = await build({ absWorkingDir: dirname(worker), stdin: { contents: entry,
  resolveDir: dirname(worker), sourcefile: 'site-search-entry.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
 const source = bundled.outputFiles[0].text;
 return { type: declaration.type, module: declaration.module, endpoint: declaration.endpoint, bindings: declaration.bindings, model, pooling, corpusHash, source };
}

export const runtimeSummary = runtime => runtime && ({ type: runtime.type, module: runtime.module, endpoint: runtime.endpoint, bindings: runtime.bindings,
 model: runtime.model, pooling: runtime.pooling, corpusHash: runtime.corpusHash, moduleDigest: digest(runtime.source) });
