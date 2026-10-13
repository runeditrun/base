import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerEditorLifecycle } from '../src/lifecycle.ts';

test('replacing one authorized owner with another retires the previous grant and pending refresh', async () => {
  let mounts = 0, cleanups = 0;
  const editor = ownerEditorLifecycle(() => { mounts++; return () => { cleanups++; }; });
  const grant = () => ({ config: { enabled:true, managementOrigin:'https://management.example', installationId:'owner_replacement' }, expiresAt:Date.now()+30000 });
  editor.setOwner(true);
  assert.equal(await editor.refresh(async () => grant()), 'mounted');
  editor.setOwner(true);
  assert.equal(cleanups, 1);
  let complete!: (value:unknown) => void;
  let signal!: AbortSignal;
  const pending = editor.refresh(abort => { signal=abort; return new Promise(resolve => { complete=resolve; }); });
  editor.setOwner(true);
  assert.equal(signal.aborted, true);
  complete(grant());
  assert.equal(await pending, 'stale');
  assert.equal(mounts, 1);
  assert.equal(await editor.refresh(async () => grant()), 'mounted');
  editor.dispose();
  assert.deepEqual({mounts,cleanups}, {mounts:2,cleanups:2});
});
