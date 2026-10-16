import { randomUUID } from 'node:crypto';
import { ApiError, taskPath } from './api.mjs';
import { saveProgress } from './progress.mjs';

export class Lease {
 constructor(api, claim, progress, outerSignal) {
  this.api = api; this.claim = claim; this.progress = progress;
  this.checkpoint = claim.task.checkpoint ?? {}; this.cursor = 0;
  this.controller = new AbortController(); this.signal = AbortSignal.any([outerSignal, this.controller.signal]);
  this.tail = Promise.resolve(); this.expires = Date.parse(claim.lease_expires_at);
  if (!Number.isFinite(this.expires) || this.expires <= Date.now()) throw new ApiError(409);
  this.timer = setInterval(() => { void this.heartbeat().catch(error => this.controller.abort(error)); }, 60_000);
  this.deadline = setInterval(() => { if (Date.now() >= this.expires) this.controller.abort(new ApiError(409)); }, 500);
 }
 serial(work) {
  const operation = this.tail.then(work);
  this.tail = operation.catch(() => {});
  return operation;
 }
 async token() {
  if (!this.bearer || Date.now() >= this.bearerUntil - 60_000) {
   const minted = await this.api.post('/api/business/executors/token', { audience: 'tasks', task_id: this.claim.task.id }, { signal: this.signal });
   if (typeof minted.access_token !== 'string' || !Number.isFinite(Number(minted.expires_in)) || minted.expires_in > 900 || minted.expires_in <= 0) throw Error('Business task bearer was invalid.');
   this.bearer = minted.access_token; this.bearerUntil = Date.now() + minted.expires_in * 1000;
  }
  return this.bearer;
 }
 async post(destination, body, { releasing = false } = {}) {
  if (!releasing) this.signal.throwIfAborted();
  const token = releasing ? this.bearer : await this.token();
  if (!token) throw Error('Business task bearer is unavailable.');
  return this.api.post(destination, { ...body, client_event_id: body.client_event_id ?? randomUUID(), fence: this.claim.fence, grant_id: this.claim.grant.id },
   { token, ...(releasing ? { timeout: 5_000 } : { signal: this.signal }) });
 }
 send(destination, body) { return this.serial(() => this.post(destination, body)); }
 heartbeat() {
  return this.serial(async () => {
   const result = await this.post(taskPath(this.claim.task.id, 'heartbeat'), { checkpoint: this.checkpoint, cursor: this.cursor });
   const expires = Date.parse(result.lease_expires_at);
   if (!Number.isFinite(expires) || expires <= Date.now()) throw new ApiError(409);
   this.expires = expires;
   this.cursor = Number.isSafeInteger(result.cursor) ? result.cursor : this.cursor;
   if (result.cancel_requested || result.controls?.some(control => control.kind === 'cancel' || control.instruction === 'pause')) {
    this.controller.abort(Error('Business task was paused or cancelled in the browser.'));
    this.signal.throwIfAborted();
   }
   // Controls contain only closed enums. A requested checkpoint is already
   // acknowledged by this heartbeat; no free-form instruction is executed.
   return result;
  });
 }
 async checkpointSaved(checkpoint) {
  this.checkpoint = checkpoint;
  this.progress.current = { kind: this.claim.task.kind, checkpoint, uploadedBytes: checkpoint.bytes_done ?? 0 };
  await saveProgress(this.progress);
  await this.heartbeat();
 }
 async complete() { clearInterval(this.timer); return this.serial(() => this.post(taskPath(this.claim.task.id, 'complete'), { outputs: {} })); }
 async release(reason = 'handover') {
  clearInterval(this.timer);
  await this.tail;
  if (!this.bearer) await this.token();
  return this.post(taskPath(this.claim.task.id, 'release'), { reason, checkpoint: this.checkpoint }, { releasing: true });
 }
 async close() { clearInterval(this.timer); clearInterval(this.deadline); await this.tail; }
}
