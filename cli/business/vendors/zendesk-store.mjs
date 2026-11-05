import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, fail, stable } from './common.mjs';

export const encode = value => Buffer.from(JSON.stringify(stable(value)) + '\n');
export const numericId = value => {
 if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) fail('INVALID_RESPONSE');
 const id = String(value);
 if (!/^(?:0|[1-9]\d{0,19})$/u.test(id)) fail('INVALID_RESPONSE');
 return id;
};
export const ordered = values => [...values].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
export const storePath = (directory, business, origin) => join(directory, `zendesk-${hash(JSON.stringify([business, origin])).slice(0,32)}`);
async function privateDirectory(path) {
 await mkdir(path, { mode: 0o700, recursive: true });
 const info = await lstat(path);
 if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) fail('INVALID_CHECKPOINT');
}
async function read(path, maximum = 64 * 1024 * 1024) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const info = await file.stat();
  if (!info.isFile() || info.size > maximum || (info.mode & 0o777) !== 0o600) fail('INVALID_CHECKPOINT');
  return await file.readFile();
 } finally { await file.close(); }
}
async function atomic(path, bytes) {
 const temporary = `${path}.${randomUUID()}.tmp`;
 const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
 await rename(temporary, path);
 const parent = await open(join(path, '..'), constants.O_RDONLY);
 try { await parent.sync(); } finally { await parent.close(); }
}
/** Immutable, content-addressed objects and journal nodes precede one atomic
 * checkpoint pointer. A kill can leave unreferenced objects, never a half-
 * acknowledged page. Reopen verifies the complete reachable graph, including
 * blobs, before making a network request. Checkpoints stay constant size. */
export class ZendeskStore {
 constructor(path) { this.path = path; this.events = []; this.head = null; this.state = null; }
 async start() {
  await privateDirectory(this.path); await privateDirectory(join(this.path, 'objects'));
  try {
   const checkpoint = JSON.parse((await read(join(this.path, 'checkpoint.json'), 128 * 1024 - 1)).toString());
   if (checkpoint.format !== 'rer-zendesk-checkpoint/1' || Object.keys(checkpoint).sort().join() !== 'format,head') fail('INVALID_CHECKPOINT');
   this.head = checkpoint.head;
   let reference = this.head;
   const seen = new Set(), backwards = [];
   while (reference) {
    if (seen.has(reference.sha256)) fail('INVALID_CHECKPOINT');
    seen.add(reference.sha256);
    const node = JSON.parse((await this.get(reference)).toString());
    if (node.format !== 'rer-zendesk-journal/1' || !node.state || !Array.isArray(node.refs)) fail('INVALID_CHECKPOINT');
    for (const ref of node.refs) await this.get(ref);
    backwards.push(node); reference = node.previous;
   }
   backwards.reverse();
   this.events = backwards.flatMap(node => node.event ? [node.event] : []);
   this.state = backwards.at(-1)?.state;
   if (!this.state) fail('INVALID_CHECKPOINT');
  } catch (error) {
   if (error.code !== 'ENOENT' || this.head) fail('INVALID_CHECKPOINT');
  }
  return this;
 }
 async get(ref) {
  if (!ref || !/^[a-f0-9]{64}$/u.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > 64 * 1024 * 1024 || ref.file !== `objects/${ref.sha256}`) fail('INVALID_CHECKPOINT');
  const bytes = await read(join(this.path, ref.file));
  if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) fail('INVALID_CHECKPOINT');
  return bytes;
 }
 async put(bytes) {
  const ref = { file: `objects/${hash(bytes)}`, sha256: hash(bytes), bytes: bytes.length };
  if (bytes.length > 64 * 1024 * 1024) fail('RECORD_LIMIT');
  const path = join(this.path, ref.file);
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await this.get(ref); return ref; }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return ref;
 }
 async commit(state, event = null, refs = []) {
  state = { ...state, requests: this.requestCount?.() ?? state.requests };
  if (!Number.isSafeInteger(state.bytes) || state.bytes > 32 * 1024 ** 3 || state.requests > 250_000) fail('BYTE_LIMIT');
  const node = { format: 'rer-zendesk-journal/1', previous: this.head, state, event, refs };
  const head = await this.put(encode(node));
  const bytes = encode({ format: 'rer-zendesk-checkpoint/1', head });
  if (bytes.length >= 128 * 1024) fail('CHECKPOINT_LIMIT');
  await atomic(join(this.path, 'checkpoint.json'), bytes);
  this.head = head; this.state = structuredClone(state);
  if (event) this.events.push(event);
 }
 async page(kind, response, state, extra = {}) {
  const raw = await this.put(response.bytes);
  await this.commit({ ...state, bytes: state.bytes + raw.bytes }, { kind, raw, ...extra }, [raw]);
 }
 async reset(state, { retain = false } = {}) {
  if (!retain) { this.events = []; this.head = null; this.cache = null; }
  await this.commit(state);
 }
 async write(name, value) {
  if (!['census.json', 'transfer.json', 'baseline.json'].includes(name)) fail('INVALID_CHECKPOINT');
  await atomic(join(this.path, name), encode(value));
 }
 async baseline() {
  try { return JSON.parse((await read(join(this.path, 'baseline.json'), 128 * 1024)).toString()); }
  catch (error) { if (error.code !== 'ENOENT') fail('INVALID_CHECKPOINT'); return null; }
 }
 async discard() { await rm(this.path, { recursive: true, force: true }); }
}
export async function removeZendeskStores(directory) {
 const { readdir } = await import('node:fs/promises');
 for (const name of await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
  if (/^zendesk-[a-f0-9]{32}$/u.test(name)) await rm(join(directory, name), { recursive: true, force: true });
 }
}
/** Collapse replayed ids and retain their last source row and provenance. */
export async function materialize(store) {
 const data = store.cache?.data ?? Object.fromEntries(['tickets','users','organizations','ticket_fields','user_segments','categories','sections','articles','translations','article_attachments'].map(kind => [kind, new Map()]));
 if (!store.cache) { data.comments = new Map(); data.attachments = new Map(); data.available = true; data.highWater = 0; }
 for (const event of store.events.slice(store.cache?.length ?? 0)) {
  if (event.kind === 'guide_unavailable') { data.available = false; continue; }
  if (event.kind === 'attachment') { data.attachments.set(event.key, event); continue; }
  if (!event.raw) continue;
  const body = JSON.parse((await store.get(event.raw)).toString());
  const rows = body[event.kind];
  if (!Array.isArray(rows)) fail('INVALID_CHECKPOINT');
  const destination = event.kind === 'comments' ? (event.reset ? new Map() : data.comments.get(event.ticket) ?? new Map()) : data[event.kind];
  if (!destination) fail('INVALID_CHECKPOINT');
  rows.forEach((row,index) => {
   const id = numericId(row.id);
   if (Buffer.byteLength(JSON.stringify(row)) > 64 * 1024 * 1024) fail('RECORD_LIMIT');
   const key = ['translations', 'article_attachments'].includes(event.kind) ? `${event.article}:${id}` : id;
   destination.set(key, { row, provenance: { file: event.raw.file, sha256: event.raw.sha256, row: index + 1, pointer: `/${event.kind}/${index}` } });
   if (event.kind === 'tickets') {
    const stamp = row.generated_timestamp;
    if (!Number.isSafeInteger(stamp) || stamp < 0) fail('INVALID_RESPONSE');
    data.highWater = Math.max(data.highWater, stamp);
   }
  });
  if (event.kind === 'comments') data.comments.set(event.ticket, destination);
 }
 store.cache = { data, length: store.events.length };
 return data;
}
