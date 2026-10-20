process.env.NODE_OPTIONS = `--import=${import.meta.filename}`;
// All provider traffic is redirected to the journey's network-edge fixture.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
 const url = new URL(input instanceof Request ? input.url : input);
 if (url.protocol !== 'https:') throw Error('Unexpected outbound request');
 return nativeFetch(process.env.RER_TEST_NETWORK, { ...init, headers: { ...init.headers, 'x-test-destination': url.href } });
};
