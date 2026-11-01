process.env.NODE_OPTIONS = `--import=${import.meta.filename}`;
// All provider traffic is redirected to the journey's network-edge fixture.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
 const url = new URL(input instanceof Request ? input.url : input);
 if (url.protocol !== 'https:') throw Error('Unexpected outbound request');
 const response = await nativeFetch(process.env.RER_TEST_NETWORK, { ...init, headers: { ...init.headers, 'x-test-destination': url.href } });
 // The edge answers x-test-network-error for a host the client cannot even connect to (a zone with no DNS record).
 const code = response.headers.get('x-test-network-error');
 if (code) throw new TypeError('fetch failed', { cause: Object.assign(Error(`getaddrinfo ${code} ${url.hostname}`), { code, hostname: url.hostname }) });
 return response;
};
