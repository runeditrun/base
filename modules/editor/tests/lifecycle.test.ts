import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerEditorLifecycle } from '../src/lifecycle.ts';
import { configLoader, parseConfig, parseGrant } from '../src/config.ts';
const config = { enabled: true, managementOrigin: 'https://management.example', installationId: 'install_42' };
const grant = () => ({ config, expiresAt: Date.now() + 30_000 });
function harness() {
  let mounts = 0, cleanups = 0;
  const editor = ownerEditorLifecycle(() => { mounts++; return () => { cleanups++; }; });
  return { editor, counts: () => ({ mounts, cleanups }) };
}
test('invalid runtime values are rejected before mounting or network', async () => {
  const h = harness(); h.editor.setOwner(true);
  for (const value of [null, 'yes', {}, [], {...config, enabled:'true'}, {...config, installationId:42}, {...config, installationId:'bad space'}, {...config, managementOrigin:'https://m.example/path'}, {...config, managementOrigin:'javascript:alert(1)'}, {...config, managementOrigin:'http://public.example'}, {...config, token:'secret'}]) {
    assert.throws(() => parseConfig(value));
    await assert.rejects(h.editor.refresh(async () => ({config:value,expiresAt:Date.now()+1000})));
  }
  assert.deepEqual(h.counts(), {mounts:0,cleanups:0});
  assert.throws(() => configLoader('https://elsewhere.example/config','https://app.example'));
  assert.throws(() => configLoader('//elsewhere.example/config','https://app.example'));
  assert.throws(() => parseGrant({...grant(), expiresAt: Date.now()+120_000}));
  h.editor.dispose();
});
test('unauthorized, disabled and disposed controllers never mount', async () => {
  const h = harness(); let loads=0;
  assert.equal(await h.editor.refresh(async () => {loads++;return grant();}), 'unauthorized');
  h.editor.setOwner(true);
  assert.equal(await h.editor.refresh(async () => ({...grant(), config:{...config,enabled:false}})), 'disabled');
  h.editor.dispose();h.editor.setOwner(true);
  assert.equal(await h.editor.refresh(async () => {loads++;return grant();}), 'unauthorized');
  assert.equal(loads,0);assert.deepEqual(h.counts(),{mounts:0,cleanups:0});
});
test('owner revocation aborts in-flight config even if loader ignores cancellation', async () => {
  const h=harness();h.editor.setOwner(true);
  let complete!: (value:unknown)=>void, signal!:AbortSignal;
  const result=h.editor.refresh(s=>{signal=s;return new Promise(resolve=>{complete=resolve;});});
  h.editor.setOwner(false);assert.equal(signal.aborted,true);complete(grant());
  assert.equal(await result,'stale');assert.deepEqual(h.counts(),{mounts:0,cleanups:0});h.editor.dispose();
});
test('new config wins races and failures remove the mount and stay visible', async () => {
  const h=harness();h.editor.setOwner(true);
  let complete!: (value:unknown)=>void;
  const old=h.editor.refresh(()=>new Promise(resolve=>{complete=resolve;}));
  assert.equal(await h.editor.refresh(async()=>grant()),'mounted');
  complete(grant());assert.equal(await old,'stale');
  await assert.rejects(h.editor.refresh(async()=>{throw new Error('server denied');}), /server denied/);
  assert.deepEqual(h.counts(),{mounts:1,cleanups:1});h.editor.dispose();h.editor.dispose();
  assert.deepEqual(h.counts(),{mounts:1,cleanups:1});
});
test('lease expiry removes private mount; renewal requires another server response', async () => {
  const h=harness();h.editor.setOwner(true);
  await h.editor.refresh(async()=>({...grant(),expiresAt:Date.now()+15}));
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.deepEqual(h.counts(),{mounts:1,cleanups:1});h.editor.dispose();
});
