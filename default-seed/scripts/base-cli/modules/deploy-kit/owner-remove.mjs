import { pause } from './cancellation.mjs';
import { checkBucket, requireBucketIdentity, removeOwnedBucket } from './r2-remove.mjs';
import { rm } from 'node:fs/promises';
import { assert, hexId } from './validation.mjs';
import { resourceKinds, findResource } from './resources.mjs';
import { deleteWorker } from './teardown.mjs';
import { recordDeployFailure } from './diagnostics.mjs';
import { query } from './migrations.mjs';
import { KINDS, readOwnerState, writeOwnerState, withStateLock, withScopeHints, withSettledLists, workerSettings, checkWorkerIdentity, resourceId, checkResourceIdentity, refuse, settlePendingSecret } from './owner.mjs';

const remove = {
  d1: (api, id) => api.request(`/d1/database/${id}`, {method:'DELETE'}),
  kv: (api, id) => api.request(`/storage/kv/namespaces/${id}`, {method:'DELETE'}),
  queues: (api, id) => api.request(`/queues/${id}`, {method:'DELETE'}),
};

/** A resource whose create response was lost (still `pending` in the state file) may be
 * rer's or someone else's. It is removed only under this environment's derived name and
 * once it is confirmed empty: a D1 with no tables or a KV namespace with no keys. R2 always
 * requires a confirmed creation identity. A queue's backlog cannot be read, so an uncertain queue refuses with its own code. */
async function confirmEmpty(api, worker, kind, name, id) {
  if (!name.startsWith(`${worker}-`)) throw refuse('uncertain-resource-create', kind, name);
  if (kind === 'queues') throw refuse('uncertain-resource-unverifiable', kind, name);
  if (kind === 'd1') {
    const [{results}] = await query(api, id, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite~_%' ESCAPE '~' AND name NOT LIKE '~_cf~_%' ESCAPE '~'");
    if (results.length) throw refuse('uncertain-resource-not-empty', kind, name);
  }
  if (kind === 'kv') {
    const keys = await api.request(`/storage/kv/namespaces/${id}/keys?limit=10`);
    assert(Array.isArray(keys), 'invalid-kv-key-list');
    if (keys.length) throw refuse('uncertain-resource-not-empty', kind, name);
  }
}

/** Delete exactly what this environment's state file says rer created: the Worker (its
 * schedules first; its Durable Objects go with it), then each D1, R2, KV and queue,
 * each only while it is still the one rer created. Read back that each is gone, then
 * drop the state file. Nothing else in the account is touched. Ownership is checked for
 * everything before the first delete; a replaced or uncertain resource refuses it all,
 * except an uncertain one confirmed empty (see confirmEmpty). A Worker whose upload
 * answer was lost is this record's own only when its live version carries the recorded
 * pending fingerprint and annotation (checkWorkerIdentity), as a deploy retry would adopt it.
 * R2 object purges additionally require the saved creation timestamp and recheck it before
 * the purge and bucket delete. `expectedResources` ({kind: [name]}) names resources a native
 * adapter's own record expects: one present but absent from this state file refuses
 * (`unrecorded-resource`); a name grants no deletion authority. */
export async function ownerRemove({api: provider, target, statePath, clock, sleep, signal, expectedResources = {}, onProgress = () => {}}) {
  const api = withSettledLists(withScopeHints(provider),{signal});
  return withStateLock(statePath, async () => {
    const state = await readOwnerState(statePath, target);
    const remaining = new Set([...(state.owned.worker ? [`worker:${target.worker}`] : []), ...KINDS.flatMap(kind => Object.keys(state.owned[kind]).map(name => `${kind}:${name}`))]);
    const removed = [], failed = [];
    try {
      if (await settlePendingSecret(api, target.worker, state, {preflight:true})) await writeOwnerState(statePath, state);
      const owned = KINDS.flatMap(kind => Object.entries(state.owned[kind]).map(([name, entry]) => ({kind, name, entry})));
      if (!state.owned.worker && !owned.length) {
        // An empty record (or one an earlier pass finished) never proves the names are free.
        if (await workerSettings(api, target.worker) !== null) throw refuse('resource-name-collision', 'worker', target.worker);
        for (const kind of KINDS) {
          const expected = expectedResources[kind] ?? [];
          const rows = expected.length ? await resourceKinds[kind].list(api) : [];
          for (const name of expected) if (findResource(rows, kind, name)) throw refuse('unrecorded-resource', kind, name);
        }
        throw new Error('nothing-to-remove');
      }
      // Preflight: provider reads only. Adopting a verified pending upload writes its ids to the record.
      let worker = null;
      if (await workerSettings(api, target.worker) !== null) {
        if (!state.owned.worker) throw refuse('resource-name-collision', 'worker', target.worker);
        await checkWorkerIdentity(api, target.worker, state, () => writeOwnerState(statePath, state));
        worker = target.worker;
      } else remaining.delete(`worker:${target.worker}`);
      assert(!state.pendingSecret, 'secret-change-unsettled');
      const listed = {}, doomed = [];
      for (const kind of KINDS) {
        const expected = expectedResources[kind] ?? [];
        if (!owned.some(item => item.kind === kind) && !expected.length) continue;
        listed[kind] = await resourceKinds[kind].list(api);
        // A missing creation record never proves the resource is absent or ours.
        for (const name of expected) if (!state.owned[kind][name] && findResource(listed[kind], kind, name)) throw refuse('unrecorded-resource', kind, name);
        for (const {name, entry} of owned.filter(item => item.kind === kind)) {
          const row = findResource(listed[kind], kind, name);
          if (!row) { remaining.delete(`${kind}:${name}`); continue; }
          if (kind === 'r2') requireBucketIdentity(name, entry);
          if (entry.status === 'pending') await confirmEmpty(api, target.worker, kind, name, resourceId(kind, row));
          else checkResourceIdentity(kind, name, row, entry);
          if (kind === 'r2' && entry.status === 'created' && entry.id) await checkBucket(api, name, entry);
          doomed.push({kind, name, entry, id:resourceId(kind, row)});
        }
      }
      // A Worker that consumes one of these queues is released first.
      for (const queue of doomed.filter(item => item.kind === 'queues')) {
        for (const consumer of await api.list(`/queues/${queue.id}/consumers`, {pagination:'single'})) {
          assert(hexId(consumer.consumer_id), 'invalid-consumer-id');
          await api.request(`/queues/${queue.id}/consumers/${consumer.consumer_id}`, {method:'DELETE'});
        }
      }
      let workerGone = true;
      if (worker) {
        onProgress(`Removing Worker ${worker}`);
        try { await deleteWorker({api, worker, signal, ...(clock ? {clock} : {}), ...(sleep ? {sleep} : {})}); }
        catch (error) {
          failed.push({resource:`worker:${worker}`, code:error.message, error});
          // Keep a surviving Worker's data. An applied delete with a failed
          // acknowledgement may proceed only after a successful absence read.
          workerGone = false;
          try { workerGone = await workerSettings(api, target.worker) === null; } catch { /* Final readback below retains unverified resources. */ }
        }
      }
      for (const item of workerGone ? doomed : []) {
        onProgress(item.kind === 'r2' ? `Purging and removing ${item.kind}:${item.name}` : `Removing ${item.kind}:${item.name}`);
        try {
          if (item.kind === 'r2') await removeOwnedBucket(api, item, {signal});
          else {
            await remove[item.kind](api, item.id, item.name);
            if (item.kind === 'queues') await waitForQueueRemoval(api,item,{clock,sleep,signal});
          }
        }
        catch (error) { failed.push({resource:`${item.kind}:${item.name}`, code:error.message, error}); }
      }
      // Only complete, successful reads prove absence. Keep every unverified
      // resource recorded even when its DELETE returned success.
      let readFailure;
      const readback = async read => { try { await read(); } catch (error) { readFailure ??= error; } };
      await readback(async () => {
        if (await workerSettings(api, target.worker) !== null) remaining.add(`worker:${target.worker}`);
        else remaining.delete(`worker:${target.worker}`);
      });
      let namespacesKnown = false;
      await readback(async () => {
        const namespaces = await api.list('/workers/durable_objects/namespaces');
        for (const row of namespaces) if (row.script === target.worker) remaining.add(`durable-object:${row.class}`);
        namespacesKnown = true;
      });
      // Missing namespace readback cannot establish that the Worker's data is gone.
      if (!namespacesKnown && state.owned.worker) remaining.add(`worker:${target.worker}`);
      for (const kind of KINDS) {
        if (!listed[kind]) continue;
        await readback(async () => {
          const rows = await resourceKinds[kind].list(api);
          for (const {name} of owned.filter(item => item.kind === kind)) {
            if (findResource(rows, kind, name)) remaining.add(`${kind}:${name}`);
            else remaining.delete(`${kind}:${name}`);
          }
        });
      }
      // A failed response can follow an applied delete or an ancillary cleanup
      // refusal. Only the independent readback decides what was removed.
      for (const resource of [ ...(worker ? [`worker:${worker}`] : []), ...doomed.map(({kind,name}) => `${kind}:${name}`) ]) {
        if (!remaining.has(resource)) removed.push(resource);
      }
      if (remaining.size || readFailure) {
        // Keep proof for every survivor or resource whose absence is unverified.
        for (const kind of KINDS) for (const name of Object.keys(state.owned[kind])) if (!remaining.has(`${kind}:${name}`)) delete state.owned[kind][name];
        if (!remaining.has(`worker:${target.worker}`) && ![...remaining].some(name => name.startsWith('durable-object:'))) {
          state.owned.worker = null; state.receipt = null; delete state.pendingUpload;
          delete state.ownerClaim; delete state.retiredSecrets;
        }
        await writeOwnerState(statePath, state);
        if (readFailure) throw readFailure;
        const workerFailure = failed.find(item => item.resource === `worker:${target.worker}` && remaining.has(item.resource));
        if (workerFailure) throw workerFailure.error;
        throw recordDeployFailure(new Error(`Removed ${removed.join(', ') || 'nothing'}; ${remaining.size} resources remain (${[...remaining].join(', ')}). Run the same removal command again after correcting the cause.`), {code:'remove-incomplete',step:'remove'});
      }
      await rm(statePath, {force:true});
      return {worker:target.worker, removed, remaining:[]};
    } catch (error) {
      error.remaining = [...remaining];
      error.failed = failed.filter(item => remaining.has(item.resource));
      error.removed = removed.filter(resource => !remaining.has(resource));
      throw error;
    }
  });
}

// Queue deletion and its account listing can settle separately. Finish the
// readback within this removal invocation, without replaying the DELETE.
async function waitForQueueRemoval(api, item, {clock = () => performance.now(), sleep, signal}) {
  const start = clock();
  for (;;) {
    if (!(await resourceKinds.queues.list(api)).some(row => row.queue_id === item.id)) return;
    if (clock() - start >= 60000) {
      const error = new Error('queue-removal-not-confirmed');
      error.providerCall = {operation:'GET /queues',reason:'Cloudflare still lists the deleted queue after 60 seconds'};
      throw error;
    }
    await pause(500,signal,sleep);
  }
}
