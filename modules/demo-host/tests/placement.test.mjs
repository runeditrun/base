import { test } from 'node:test';
import assert from 'node:assert/strict';
import { front, cookieHeader } from './front.mjs';

test('a visitor waits for placement on the same reservation; exhausted placement refuses cleanly and releases it', async () => {
  const first = await front({ max: 1, placementFailures: 2, startMs: 5000 });
  try {
    const response = await first.begin({headers:{accept:'application/json'}});
    assert.equal(response.status,202);
    const cookie=cookieHeader(response);
    assert.equal((await first.begin({ip:'203.0.113.2'})).status,503);
    let state=response;
    for(let i=0;i<120&&state.status===202;i++){
      await new Promise(resolve=>setTimeout(resolve,50));
      state=await first.fetch('/__demo/status',{headers:{accept:'application/json',cookie}});
      if(state.status===202) assert.equal(cookieHeader(state),cookie);
    }
    assert.equal(state.status,200);
    assert.equal((await state.json()).location,'/app');
    assert.equal(first.demos.size,1);
    assert.equal((await first.fetch('/app',{headers:{cookie:cookieHeader(state)}})).status,200);
  } finally {await first.mf.dispose();}
  const full=await front({max:1,placementFailures:1000,startMs:500});
  try {
    const response=await full.start({headers:{accept:'application/json'}});
    assert.equal(response.status,503);
    const fresh=await full.begin({ip:'203.0.113.3',headers:{accept:'application/json'}});
    assert.equal(fresh.status,202,'the failed placement must release the reservation');
    assert.equal(full.demos.size,0);
  } finally {await full.mf.dispose();}
});
