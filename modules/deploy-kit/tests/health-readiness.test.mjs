import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare, deploy, verifyHealth, defaultStagePlan } from '../index.mjs';
import { hash } from '../validation.mjs';
import { providerFixture } from './provider-fixture.mjs';

// The authenticated verifier and the publication readiness wait are one module:
// /health gets the same bounded window for route and binding propagation.
function setup(t) {
  const fixture = providerFixture(); t.after(() => fixture.close());
  const source = 'export default {scheduled() {},fetch(){return new Response("ok")}}';
  const artifact = {version:1,source:{sha:'7'.repeat(40),tree:'8'.repeat(40)},run:{id:'4242',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],assets:[],migrations:[]};
  const plan = defaultStagePlan(artifact);
  let elapsed = 0; const sleeps = [];
  const clock = {now:() => elapsed,sleep:async ms => { sleeps.push(ms); elapsed += ms; }};
  return {...fixture,clock,sleeps,args:{api:cloudflare(fixture),plan,artifact,artifactSha256:hash(artifact),fetch:fixture.fetch}};
}
function sequence(state, results) {
  state.healthOverride = () => {
    const next = results.shift();
    if (!results.length) state.healthOverride = null;
    if (next instanceof Error) throw next;
    return new Response('',{status:next});
  };
}

test('health that settles from 404 and 503 inside the window passes, with bounded waits', async t => {
  const {args,state,clock,sleeps} = setup(t);
  let calls = 0;
  const fetch = (url, init) => { if (new URL(url).hostname.endsWith('.workers.dev')) calls++; return args.fetch(url, init); };
  sequence(state,[404,503]);
  const receipt = await deploy({...args,fetch,healthOptions:clock});
  assert.equal(receipt.changed,true);
  assert.deepEqual(sleeps,[2000,2000]);
  assert.equal(calls,3);
  sequence(state,[new TypeError('test-only connection reset')]);
  assert.equal((await verifyHealth({...args,receipt,fetch,...clock})).ok,true);
  assert.deepEqual(sleeps,[2000,2000,2000]);
  assert.equal(calls,5);
});

test('standalone health verification recovers from each transient HTTP status', async t => {
  for (const status of [404,503]) {
    const {args,state,clock,sleeps} = setup(t);
    const receipt = await deploy(args);
    let calls = 0;
    const fetch = (url,init) => {
      if (new URL(url).hostname.endsWith('.workers.dev')) calls++;
      return args.fetch(url,init);
    };
    sequence(state,[status]);
    assert.equal((await verifyHealth({...args,receipt,fetch,...clock})).ok,true, `standalone ${status} recovers`);
    assert.equal(calls,2, `standalone ${status} retries once`);
    assert.deepEqual(sleeps,[2000], `standalone ${status} waits within the window`);
  }
});

test('health that never settles fails with the deploy-kit code at the deadline', async t => {
  const {args,state,clock,sleeps} = setup(t);
  const receipt = await deploy(args);
  for (const [response,code] of [
    [() => new Response('',{status:503}),'health-http-failed'],
    [() => { throw new TypeError('test-only connection reset'); },'health-transport-failed'],
  ]) {
    let calls = 0;
    sleeps.length = 0;
    state.healthOverride = () => { calls++; return response(); };
    await assert.rejects(verifyHealth({...args,receipt,timeoutMs:6000,...clock}),error => error.message === code);
    assert.equal(calls,3);
    assert.deepEqual(sleeps,[2000,2000,2000]);
  }
  for (const status of [401,302,500]) {
    let calls = 0;
    sleeps.length = 0;
    state.healthOverride = () => { calls++; return new Response('',{status}); };
    await assert.rejects(verifyHealth({...args,receipt,...clock}),error => error.message === 'health-http-failed');
    assert.equal(calls,1);
    assert.deepEqual(sleeps,[]);
  }
});

test('the health request carries no credential and asks for uncached JSON without following redirects', async t => {
  const {args,clock,sleeps} = setup(t);
  const seen = [];
  const fetch = async (url,init) => { if (new URL(url).hostname.endsWith('.workers.dev')) seen.push(init); return args.fetch(url,init); };
  const receipt = await deploy({...args,fetch,healthOptions:clock});
  await verifyHealth({...args,receipt,fetch,...clock});
  assert.equal(seen.length,2);
  assert.deepEqual(sleeps,[],'immediately healthy deploy and verification each make one read without waiting');
  for (const init of seen) {
    assert.equal(init.redirect,'manual');
    assert.deepEqual(init.headers,{'Cache-Control':'no-cache','Accept':'application/json'});
    assert.ok(init.signal instanceof AbortSignal);
  }
});
