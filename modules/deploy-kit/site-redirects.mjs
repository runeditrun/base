// The first site redirect contract is deliberately limited to canonical docs paths.
const DOC_PATH = /^\/docs\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
export const MAX_SITE_REDIRECTS = 500;
export function siteRedirects(value = []) {
  const invalid = () => { throw new Error('invalid-site-redirects'); };
  if (!Array.isArray(value)) invalid();
  if (value.length > MAX_SITE_REDIRECTS) throw new Error(`Run site redirects must contain at most ${MAX_SITE_REDIRECTS} rules.`);
  const sources = new Set();
  const rules = value.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).sort().join() !== 'from,status,to' || rule.status !== 301
      || ![rule.from, rule.to].every(path => typeof path === 'string' && DOC_PATH.test(path) && path !== '/docs/search')
      || rule.from === rule.to || sources.has(rule.from)) invalid();
    sources.add(rule.from);
    return { from: rule.from, to: rule.to, status: 301 };
  });
  if (rules.some(rule => sources.has(rule.to))) invalid();
  return rules;
}

/** Exact URL.pathname, GET/HEAD only, query kept verbatim. Canonical host goes first. */
export function siteRedirectResponse(request, redirects) {
  const url = new URL(request.url);
  if (url.hostname.startsWith('www.') || !['GET', 'HEAD'].includes(request.method)) return null;
  const rule = redirects.find(rule => rule.from === url.pathname);
  return rule ? new Response(null, { status: 301, headers: { location: rule.to + url.search } }) : null;
}
