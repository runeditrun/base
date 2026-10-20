import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { validRelativePath } from './signature.mjs';

// Inspect the WebP container and encoded image dimensions, not its extension or
// the author's width/height claim. No image decoder or browser is required.
function webpSize(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw Error('Screenshot must be a complete WebP image');
  let canvas, image;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw Error('Invalid WebP chunk');
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size + (size & 1) > bytes.length) throw Error('Invalid WebP chunk length');
    if (type === 'VP8X' && size === 10) {
      if (bytes[start] & 2) throw Error('Screenshot WebP must be a still image');
      canvas = [1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3)];
    } else if (type === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      image = [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
    } else if (type === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
      const bits = bytes.readUInt32LE(start + 1);
      image = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    offset = start + size + (size & 1);
  }
  if (!image || (canvas && (canvas[0] !== image[0] || canvas[1] !== image[1]))) throw Error('Invalid WebP image dimensions');
  return image;
}

export function screenshotSet(source, id) {
  const screenshots = source.release?.screenshots;
  if (screenshots === undefined) return { shots: [], assets: [], identity: null };
  if (!Array.isArray(screenshots) || screenshots.length < 1 || screenshots.length > 5) throw Error('RELEASE.json screenshots requires 1–5 images');
  const paths = new Set(), assets = [];
  const shots = screenshots.map(shot => {
    if (!validRelativePath(shot?.path) || !shot.path.endsWith('.webp') || !['alt', 'caption'].every(key => typeof shot[key] === 'string' && shot[key].trim()) || shot.width !== 1600 || shot.height !== 1000)
      throw Error('Each screenshot needs a WebP path, alt, caption, width 1600 and height 1000');
    const bytes = source.bytes(shot.path), [width, height] = webpSize(bytes);
    if (width !== 1600 || height !== 1000 || bytes.length > 300 * 1024) throw Error('Screenshot WebP must be 1600x1000 and at most 300 KiB');
    const path = `assets/seeds/${id}/${basename(shot.path)}`;
    if (paths.has(path) || ['mark.svg', 'mark-light.svg'].includes(basename(shot.path))) throw Error('Screenshot bundle paths must be unique');
    paths.add(path); assets.push({ path, bytes });
    return { path, alt: shot.alt, caption: shot.caption, width, height };
  });
  // Byte identity plus source names distinguish a recapture at the same path
  // from unchanged pictures; copy edits alone cannot claim a fresh capture.
  const identities = screenshots.map((shot, index) => [shot.path, createHash('sha256').update(assets[index].bytes).digest('hex')])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const identity = createHash('sha256').update(JSON.stringify(identities)).digest('hex');
  return { shots, assets, identity };
}
