export const prefixFor = (id, binding) => `${id}/${binding}/`;
function metadata(value, prefix) {
  if (!value) return value;
  const result = {};
  for (const key of ['key', 'version', 'size', 'etag', 'httpEtag', 'uploaded', 'httpMetadata', 'customMetadata', 'range', 'storageClass', 'body']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  result.key = result.key.slice(prefix.length);
  if (value.checksums) result.checksums = Object.fromEntries(['md5', 'sha1', 'sha256', 'sha384', 'sha512'].filter(key => value.checksums[key]).map(key => [key, value.checksums[key]]));
  return result;
}
export async function r2Call(bucket, storage, id, binding, method, args) {
  const prefix = prefixFor(id, binding), key = value => prefix + String(value);
  if (method === 'list') {
    const options = args[0] ?? {};
    const page = await bucket.list({ ...options, prefix: key(options.prefix ?? ''), ...(options.startAfter ? { startAfter: key(options.startAfter) } : {}) });
    return { ...page, objects: page.objects.map(value => metadata(value, prefix)), delimitedPrefixes: page.delimitedPrefixes.map(value => value.slice(prefix.length)) };
  }
  if (method === 'delete') return bucket.delete(Array.isArray(args[0]) ? args[0].map(key) : key(args[0]));
  if (['get', 'head', 'put'].includes(method)) return metadata(await bucket[method](key(args[0]), ...args.slice(1)), prefix);
  if (method === 'createMultipartUpload') {
    const upload = await bucket.createMultipartUpload(key(args[0]), args[1]);
    try { await storage.put(`upload:${upload.uploadId}`, { key: key(args[0]), uploadId: upload.uploadId }); }
    catch (error) { await upload.abort(); throw error; }
    return upload.uploadId;
  }
  if (['uploadPart', 'abort', 'complete'].includes(method)) {
    const upload = bucket.resumeMultipartUpload(key(args[0]), args[1]);
    const result = await upload[method](...args.slice(2));
    if (method !== 'uploadPart') await storage.delete(`upload:${args[1]}`);
    return method === 'complete' ? metadata(result, prefix) : result;
  }
  throw new Error(`Unsupported R2 method: ${method}`);
}
export async function eraseR2(bucket, storage, id) {
  if (!bucket) return;
  for (const { key, uploadId } of (await storage.list({ prefix: 'upload:' })).values()) await bucket.resumeMultipartUpload(key, uploadId).abort();
  for (;;) {
    const page = await bucket.list({ prefix: `${id}/`, limit: 1000 });
    if (!page.objects.length) break;
    await bucket.delete(page.objects.map(value => value.key));
  }
}
