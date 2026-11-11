// A local run is served from this computer's own loopback address or a `NAME.localhost`
// front door; a deployed app and a hosted demo are served from a public name.
export function isLocalRun(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}
