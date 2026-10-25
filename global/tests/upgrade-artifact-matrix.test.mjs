import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { artifactMatrix, heads, locks, protectedStages, results, rollbackStages, stages, trees } from './fixtures/upgrade/artifact-matrix.mjs';

test('the packed upgrade door preserves owner work across the durable artifact matrix', { timeout: 20 * 60_000 }, async t => {
 const matrix = await artifactMatrix(t);
 const failures = [];
 let count = 0;
 for (const lock of locks) {
  const release = lock === 'live second updater' ? await matrix.hold() : null;
  try {
   for (const stage of stages) for (const head of heads) for (const tree of trees) {
    const cell = { stage, head, tree, lock };
    let outcome = null, code = null, retained = null, edits = null, passed = false;
    try {
     const before = await matrix.put(cell);
     const response = await matrix.invoke(cell);
     const verdicts = results(response);
     assert.equal(verdicts.length, 1, 'the public door must emit one closed result');
     ({ outcome, error_code: code = null } = verdicts[0]);
     const after = await matrix.observe();
     retained = {
      journal: before.journalBytes === after.journalBytes,
      intent: before.intentBytes === after.intentBytes,
      candidate: before.candidate === after.candidate,
      snapshot: isDeepStrictEqual(after.saved, matrix.savedSnapshot),
      snapshotReferenced: after.journal?.backup === matrix.backupName,
     };
     edits = {
      head: before.head === after.head && before.branch === after.branch,
      tracked: before.tracked === after.tracked,
      untracked: before.untracked === after.untracked,
      committed: before.committedOwner === after.committedOwner,
      local: before.local === after.local,
      data: isDeepStrictEqual(after.data, matrix.savedData),
     };
     assert.ok(['updated', 'refused', 'needs_integration', 'rolled_back'].includes(outcome), 'outcome must be closed');
     assert.ok([null, 'refused', 'not_on_branch', 'worktree_dirty', 'needs_integration', 'rollback_failed'].includes(code), 'error code must be closed for this matrix');
     assert.doesNotMatch(response.stdout + response.stderr, /git\s+reset\s+--hard|rer\s+dev\s+--stop/i, 'diagnostics must not prescribe destructive recovery');
     for (const [kind, kept] of Object.entries(edits)) assert.equal(kept, true, `owner ${kind} must be preserved`);
     assert.equal(retained.snapshot, true, 'the real local-state snapshot must remain intact');
     if (code === 'rollback_failed') assert.equal(rollbackStages.has(stage), true, 'only an existing failed or interrupted rollback may report rollback_failed');

     const invalidHead = ['detached', 'unborn'].includes(head) || head === 'other branch' && tree === 'clean' && protectedStages.has(stage);
     const prepare = lock === 'none' && !invalidHead && tree === 'clean' && !protectedStages.has(stage);
     if (lock === 'live second updater') {
      assert.equal(outcome, 'refused'); assert.equal(code, 'refused');
      for (const word of ['another', 'upgrade', 'running']) assert.match(response.stderr, new RegExp(word, 'i'), 'the reason must identify the live second updater');
      assert.doesNotMatch(response.stderr, /--restore|\brecover(?:y)?\b|git\s+reset|rer\s+dev/i, 'lock contention must not offer recovery advice');
     } else if (invalidHead) {
      assert.equal(outcome, 'refused');
      assert.ok(['not_on_branch', 'refused'].includes(code), 'detached, unborn or protected wrong-branch HEAD must refuse plainly');
     } else if (tree !== 'clean') {
      assert.equal(outcome, 'refused'); assert.equal(code, 'worktree_dirty');
     } else if (protectedStages.has(stage)) {
      assert.equal(outcome, 'refused');
      assert.ok(code === 'refused' || rollbackStages.has(stage) && code === 'rollback_failed', 'a protected selector mismatch must refuse without initiating rollback');
     } else {
      assert.equal(response.code, 0, 'a discardable artifact must permit fresh signed preparation');
      assert.equal(code, null);
      assert.equal(after.journal?.stage, 'prepared');
      assert.equal(after.journal?.head, before.head, 'fresh preparation must use today\'s HEAD');
      assert.equal(after.journal?.branch, before.branch, 'fresh preparation must use today\'s branch');
      assert.equal(after.journal?.target?.commit, matrix.next.commit);
      assert.ok(after.journal?.prepared?.candidate, 'successful --check must retain its real candidate');
     }
     if (!prepare) {
      for (const kind of ['journal', 'intent', 'candidate']) assert.equal(retained[kind], true, `refusal must retain the existing ${kind}`);
      assert.equal(response.code, 1, 'a refused public command must fail closed');
     }
     if (protectedStages.has(stage)) assert.equal(retained.snapshotReferenced, true, 'protected stages must retain their recovery snapshot reference');
     passed = true;
    } catch (error) {
     failures.push({ ...cell, error: error.message });
    }
    count++;
    t.diagnostic(JSON.stringify({ matrix: 'upgrade-artifacts', ...cell, outcome, code, retained, edits, passed }));
   }
  } finally { await release?.(); }
 }
 t.diagnostic(JSON.stringify({ matrix: 'upgrade-artifacts', count, failures: failures.length }));
 assert.equal(count, stages.length * heads.length * trees.length * locks.length);
 assert.deepEqual(failures, [], 'every hostile artifact cell must preserve owner work and obey the public outcome table');
});
