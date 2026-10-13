import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { until } from './helpers.mjs';

// Read the queue's atomic snapshots without status() reclaiming a lease for us.
// Gated commands keep grants observable until the test explicitly releases them.
export function recordedState(directory, slots = 1) {
  async function read() {
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.ok(state.running.length <= slots, 'Recorded leases must stay within capacity');
    const ids = [...state.queued, ...state.running].map(job => job.id);
    assert.equal(new Set(ids).size, ids.length, 'A request appears exactly once in queue state');
    return state;
  }
  return { read, wait: predicate => until(async () => {
    let state;
    try { state = await read(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return predicate(state) ? state : false;
  }) };
}
