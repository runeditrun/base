// Dynamic Start documents and RPCs can contain cookie-authorized data, including
// serialized redirects. Apply this at the final response boundary so framework
// serialization cannot discard the policy. Built files come from env.ASSETS
// (staticAssetResponse in server.ts) with their normal cache policy.
export function uncachedStartResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  // no-transform: no proxy rewrites the document React hydrates (Cloudflare's
  // email address obfuscation honours it).
  headers.set('cache-control', 'no-store, no-transform')
  // Pass through the original stream without reading, cloning or re-encoding it.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
