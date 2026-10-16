function object(value) {
  if (!value) return value;
  value.writeHttpMetadata = headers => {
    for (const [key, content] of Object.entries(value.httpMetadata ?? {})) {
      const header = { contentType: 'content-type', contentLanguage: 'content-language', contentDisposition: 'content-disposition', contentEncoding: 'content-encoding', cacheControl: 'cache-control', cacheExpiry: 'expires' }[key];
      if (header) headers.set(header, content instanceof Date ? content.toUTCString() : content);
    }
  };
  if (value.body) {
    const response = new Response(value.body);
    Object.defineProperty(value, 'bodyUsed', { get: () => response.bodyUsed });
    for (const method of ['arrayBuffer', 'text', 'json', 'blob']) value[method] = () => response[method]();
    value.bytes = async () => new Uint8Array(await response.arrayBuffer());
  }
  return value;
}
// RPC does not preserve a stream's known byte length, which R2 requires.
// Seed upload limits keep these demo bodies bounded; multipart parts are
// buffered separately rather than collecting the complete multipart object.
const bytes = value => value instanceof Blob ? value.arrayBuffer() : value instanceof ReadableStream ? new Response(value).arrayBuffer() : value;
export class DemoR2 {
  constructor(host, binding) { this.host = host; this.binding = binding; }
  call(method, ...args) { return this.host.r2(this.binding, method, args); }
  async get(key, options) { return object(await this.call('get', key, options)); }
  async head(key) { return object(await this.call('head', key)); }
  async put(key, body, options) { return object(await this.call('put', key, await bytes(body), options)); }
  delete(keys) { return this.call('delete', keys); }
  async list(options) { const page = await this.call('list', options); page.objects = page.objects.map(object); return page; }
  async createMultipartUpload(key, options) { return this.resumeMultipartUpload(key, await this.call('createMultipartUpload', key, options)); }
  resumeMultipartUpload(key, uploadId) {
    return { key, uploadId,
      uploadPart: async (part, body, options) => this.call('uploadPart', key, uploadId, part, await bytes(body), options),
      abort: () => this.call('abort', key, uploadId),
      complete: async parts => object(await this.call('complete', key, uploadId, parts)),
    };
  }
}
