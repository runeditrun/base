import { fail, digest, canonical } from './policy.mjs';
const MAX_BYTES = 10 * 1024 * 1024;
const invalid = () => fail('ai_image_invalid', 422);
function crc(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); }
  return (n ^ 0xffffffff) >>> 0;
}
/** Conservative PNG subset. JPEG/WebP stay refused until their adapters are proven. */
export async function png(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES || bytes.length < 57 || ![137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width, height, channels, ended = false, dataEnded = false;
  const data = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const size = view.getUint32(offset), end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if (crc(bytes.subarray(offset+4,end-4)) !== view.getUint32(end-4)) invalid();
    if (offset === 8 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (width !== undefined || size !== 13) invalid();
      width = view.getUint32(offset+8); height = view.getUint32(offset+12);
      const depth = bytes[offset+16], colour = bytes[offset+17];
      channels = colour === 2 ? 3 : colour === 6 ? 4 : 0;
      if (!width || !height || width > 4096 || height > 4096 || width*height > 16000000 || depth !== 8 || !channels || bytes[offset+18] || bytes[offset+19] || bytes[offset+20]) invalid();
    } else if (type === 'IDAT') {
      if (dataEnded || !size) invalid();
      data.push(bytes.slice(offset+8,end-4));
    } else if (type === 'IEND') {
      if (size || !data.length || end !== bytes.length) invalid();
      ended = true;
    } else {
      // Refuse ancillary metadata and unknown chunks as well as active formats.
      invalid();
    }
    if (data.length && type !== 'IDAT') dataEnded = true;
    offset = end;
  }
  if (!ended) invalid();
  const stride = width*channels+1, expected = stride*height;
  const stream = new Blob(data).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  let count = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      if (count+value.length > expected) { await reader.cancel(); invalid(); }
      for (let i = (stride-count%stride)%stride; i < value.length; i += stride) if (value[i] > 4) { await reader.cancel(); invalid(); }
      count += value.length;
    }
  } catch { invalid(); }
  if (count !== expected) invalid();
  return { bytes, mime:'image/png', width, height, digest:await digest(bytes) };
}
export async function imageEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'image') || typeof value.image !== 'string' || value.image.length > 4*Math.ceil(MAX_BYTES/3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.image)) invalid();
  let decoded;
  try { decoded = atob(value.image); } catch { invalid(); }
  if (decoded.length > MAX_BYTES) invalid();
  return png(Uint8Array.from(decoded, c => c.charCodeAt(0)));
}
export async function imageKey(policy, purpose) {
  return `ai/private/${await digest(canonical([policy.installation,policy.environment,policy.tenant,purpose]))}.png`;
}
export async function adopt(bucket, key, operation, scope) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (!operation.object_digest || object.size > MAX_BYTES || object.customMetadata?.operation !== operation.id || object.customMetadata?.scope !== scope || !/^[a-f0-9]{64}$/.test(object.customMetadata?.digest ?? '') || object.httpMetadata?.contentType !== 'image/png') fail('ai_image_collision');
  const valid = await png(new Uint8Array(await object.arrayBuffer()));
  if (valid.digest !== object.customMetadata.digest || operation.object_digest && valid.digest !== operation.object_digest) fail('ai_image_collision');
  return valid;
}
