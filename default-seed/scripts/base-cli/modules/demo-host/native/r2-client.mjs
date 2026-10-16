const HEADERS = { contentType: 'content-type', contentLanguage: 'content-language', contentDisposition: 'content-disposition', contentEncoding: 'content-encoding', cacheControl: 'cache-control', cacheExpiry: 'expires' };
function object(value) {
  if (!value) return value;
  value.writeHttpMetadata = headers => {
    for (const [key, content] of Object.entries(value.httpMetadata ?? {})) {
      const header = HEADERS[key];
      if (header) headers.set(header, content instanceof Date ? content.toUTCString() : content);
    }
  };
  if ('body' in value) {
    const response = new Response(value.body);
    value.body = response.body;
    Object.defineProperty(value, 'bodyUsed', { get: () => response.bodyUsed });
    for (const method of ['arrayBuffer', 'text', 'json', 'blob']) value[method] = () => response[method]();
    value.bytes = async () => new Uint8Array(await response.arrayBuffer());
  }
  return value;
}
// Headers forms of R2 options become their plain forms before crossing RPC.
function httpMetadata(value) {
  if (!(value instanceof Headers)) return value;
  const result = {};
  for (const [key, header] of Object.entries(HEADERS)) if (value.has(header)) result[key] = key === 'cacheExpiry' ? new Date(value.get(header)) : value.get(header);
  return result;
}
function conditional(value) {
  if (!(value instanceof Headers)) return value;
  const date = name => value.has(name) ? new Date(value.get(name)) : undefined;
  return { etagMatches: value.get('if-match') ?? undefined, etagDoesNotMatch: value.get('if-none-match') ?? undefined,
    uploadedAfter: date('if-modified-since'), uploadedBefore: date('if-unmodified-since'), secondsGranularity: true };
}
const plain = (options = {}) => ({ ...options,
  ...(options.httpMetadata ? { httpMetadata: httpMetadata(options.httpMetadata) } : {}),
  ...(options.onlyIf ? { onlyIf: conditional(options.onlyIf) } : {}),
  ...(options.range instanceof Headers ? { range: options.range.has('range') ? { header: options.range.get('range') } : undefined } : {}) });
// Bodies stream to the visitor's storage; only Blobs are read first.
const body = value => value instanceof Blob ? value.arrayBuffer() : value;
export class DemoR2 {
  constructor(host, binding) { this.host = host; this.binding = binding; }
  call(method, ...args) { return this.host.r2(this.binding, method, args); }
  async get(key, options) { return object(await this.call('get', key, plain(options))); }
  async head(key) { return object(await this.call('head', key)); }
  async put(key, value, options) { return object(await this.call('put', key, await body(value), plain(options))); }
  delete(keys) { return this.call('delete', keys); }
  async list(options) { const page = await this.call('list', options); page.objects = page.objects.map(object); return page; }
  async createMultipartUpload(key, options) { return this.resumeMultipartUpload(key, await this.call('createMultipartUpload', key, plain(options))); }
  resumeMultipartUpload(key, uploadId) {
    return { key, uploadId,
      uploadPart: async (part, value, options) => this.call('uploadPart', key, uploadId, part, await body(value), options),
      abort: () => this.call('abort', key, uploadId),
      complete: async parts => object(await this.call('complete', key, uploadId, parts)),
    };
  }
}
