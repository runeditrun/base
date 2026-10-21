import { createSearcher } from './retrieve';
import { searchPolicy } from './policy.mjs';
import type { Embed, SearchIndex, SearchResult } from './types';

type Environment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AI: { run: Embed };
  SEARCH_RATE_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
};
const json = (data: unknown, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');

/** Shared caches hold only public results; no request headers, visitor identity
 * or raw query is put in a cache key or a cached response. Failures stay private. */
export function createSearchWorker({ corpusHash, endpoint = '/docs/search', indexAsset = '/docs-search-vectors.json', model = '@cf/baai/bge-base-en-v1.5', pooling = 'cls' }: { corpusHash: string; endpoint?: string; indexAsset?: string; model?: string; pooling?: string }) {
  let loading: Promise<{ index: SearchIndex; search: ReturnType<typeof createSearcher> }> | undefined;
  const pending = new Map<string, Promise<SearchResult[]>>();
  function load(request: Request, env: Environment) {
    if (!loading) {
      loading = (async () => {
        const response = await env.ASSETS.fetch(new Request(new URL(indexAsset, request.url)));
        if (!response.ok) throw Error('Search index unavailable');
        const index = await response.json() as SearchIndex;
        if (index.corpusHash !== corpusHash || index.version !== 1 || index.pooling !== pooling || index.model !== model || !index.dimensions || !Array.isArray(index.chunks)) throw Error('Invalid search index');
        return { index, search: createSearcher(index) };
      })().catch(error => { loading = undefined; throw error; });
    }
    return loading;
  }
  return {
    async fetch(request: Request, env: Environment): Promise<Response> {
      const url = new URL(request.url);
      if (url.hostname.startsWith('www.')) return Response.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 301);
      if (url.pathname !== endpoint) return env.ASSETS.fetch(request);
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
      const raw = (url.searchParams.get('q') ?? '').trim();
      if (raw.length > 240) return json({ error: 'Query too long' }, 400);
      const query = raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
      if (query.length < 2) return json({ results: [] });
      if (query.length > 240) return json({ error: 'Query too long' }, 400);
      try {
        const key = new Request(new URL(`/.rer/docs-search-cache/${corpusHash}/${await digest(JSON.stringify([model, pooling, query]))}`, url.origin));
        // Cache API is location-local and evictable. Single-flight below is only
        // isolate-local; neither mechanism is an account-wide accounting system.
        // The DOM type omits the Workers default Cache API extension.
        const cache = (caches as CacheStorage & { default: Cache }).default;
        const cached = await cache.match(key);
        if (cached) return json(await cached.json());
        let work = pending.get(key.url);
        if (!work) {
          const visitor = request.headers.get('CF-Connecting-IP');
          if (!visitor || !env.SEARCH_RATE_LIMITER || pending.size >= searchPolicy.maxPending) throw Error('Search admission unavailable');
          const admitted = await env.SEARCH_RATE_LIMITER.limit({ key: `rer:docs-search:${await digest(url.origin + '\n' + visitor)}` });
          if (!admitted.success && !pending.has(key.url)) return json({ error: 'Too many searches. Try again in a minute.' }, 429, { 'Retry-After': String(searchPolicy.period) });
          // Another request may have been admitted while the binding was awaited.
          work = pending.get(key.url);
          if (!work) {
            if (pending.size >= searchPolicy.maxPending) throw Error('Search busy');
            work = (async () => {
              const { index, search } = await load(request, env);
              const vectors = await env.AI.run(index.model, { text: [`Represent this sentence for searching relevant passages: ${query}`], pooling: index.pooling });
              const results = search(vectors.data[0], query);
              // Wait for the write before releasing single-flight, closing the
              // gap between inference finishing and a later cache lookup.
              await cache.put(key, Response.json({ results }, { headers: { 'Cache-Control': `public, max-age=${searchPolicy.cacheSeconds}` } }));
              return results;
            })();
            pending.set(key.url, work);
            const remove = () => { pending.delete(key.url); };
            void work.then(remove, remove);
          }
        }
        return json({ results: await work });
      } catch {
        return json({ error: 'Search unavailable' }, 503);
      }
    },
  };
}
