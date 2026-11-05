import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Synthetic legacy database export; large objects are generated, never committed. */
export async function legacyPackage(root, { large = false } = {}) {
 await mkdir(root, { recursive: true });
 const tables = { conversations: [{ id: 11, subject: 'Old conversation' }, { id: 12, subject: 'Another conversation' }],
  messages: [{ id: 21, conversation_id: 11, text: 'Hello' }, { id: 22, conversation_id: 11, text: 'A reply' }, { id: 23, conversation_id: 12, text: 'History' }], users: [{ id: 31, name: 'Synthetic person' }] };
 const chunks = [], files = new Map();
 for (const [table, rows] of Object.entries(tables)) {
  const bytes = Buffer.from(JSON.stringify(rows)), file = `rows-${table}-000001.json`;
  files.set(file, bytes); chunks.push({ table, file, bytes: bytes.length, sha256: sha(bytes), count: rows.length });
 }
 const contextBytes = Buffer.from(JSON.stringify(tables.users)), context = [{ table: 'users', file: 'context-users.json', bytes: contextBytes.length, sha256: sha(contextBytes), count: tables.users.length }];
 files.set(context[0].file, contextBytes);
 const objects = [large ? Buffer.alloc(3 * 1024 ** 2, 0xab) : Buffer.from('original customer media'), large ? Buffer.alloc(2 * 1024 ** 2, 0x35) : Buffer.from('second object')].map((bytes, i) => {
  const file = `media-${i}.bin`; files.set(file, bytes);
  return { file, key: `legacy/media/${i}`, mediaId: i + 1, size: bytes.length, sha256: sha(bytes) };
 });
 const manifest = { format: 'happytohelp-legacy-chunks-v1', exportedAt: '2026-10-16T00:00:00.000Z', attachmentsComplete: true,
  source: { origin: 'legacy-database', synthetic: true, rowCounts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])), attachments: objects.map(({ key, mediaId }) => ({ key, mediaId })) }, chunks, context, objects };
 files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
 for (const [file, bytes] of files) await writeFile(join(root, file), bytes);
 return { root, files, manifest };
}

/** Network-edge fixture independently resolves and hashes the declared stream and files. */
export function packageFiles(manifest, uploads, namespace) {
 const missing = [], segments = [];
 for (const segment of manifest.segments) {
  const upload = [...uploads.values()].find(u => u.namespace === namespace && u.name === 'rer-segment' && u.bundleSha256 === segment.sha256 && u.totalBytes === segment.bytes && u.bytes && sha(u.bytes) === segment.sha256);
  if (!upload) missing.push(segment); else segments.push(upload.bytes);
 }
 if (missing.length) throw Object.assign(Error('package_segment_missing'), { code: 'package_segment_missing', status: 409, details: { missing } });
 const stream = Buffer.concat(segments);
 if (sha(stream) !== manifest.stream.sha256 || stream.length !== manifest.stream.bytes) throw Error('Invalid fixture package stream');
 const index = stream.subarray(0, manifest.index.bytes);
 if (sha(index) !== manifest.index.sha256) throw Error('Invalid fixture package index');
 return new Map(index.toString().trim().split('\n').map(line => {
  const file = JSON.parse(line), bytes = stream.subarray(index.length + file.offset, index.length + file.offset + file.bytes);
  if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw Error('Invalid fixture package file');
  return [file.path, bytes];
 }));
}
