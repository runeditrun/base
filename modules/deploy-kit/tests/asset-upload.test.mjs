import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare } from '../provider.mjs';
import { uploadAssets } from '../worker.mjs';
import { hash } from '../validation.mjs';

test('static asset multipart preserves JavaScript MIME for imported browser .mjs and .js, and binary MIME for unknown extensions', async () => {
  const cases = [
    {path:'app.js',bytes:'import { feedback } from "./assets/action-feedback.mjs"; feedback();',type:'application/javascript'},
    {path:'assets/action-feedback.mjs',bytes:'export const feedback = () => document.body.dataset.ready = "yes";',type:'application/javascript'},
    {path:'assets/data.unknown',bytes:Buffer.from([0,255,1,128]),type:'application/octet-stream'},
  ];
  const files = cases.map(({path,bytes}) => ({path,base64:Buffer.from(bytes).toString('base64'),sha256:hash(bytes)}));
  const accountId = 'a'.repeat(32);
  const origin = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const calls = [];
  const api = cloudflare({accountId,token:'fixture-account-token',fetch:async (url,init) => {
    const request = new Request(url,init);
    calls.push(request);
    if (url === `${origin}/workers/scripts/browser-assets/assets-upload-session`) {
      const {manifest} = await request.clone().json();
      return Response.json({success:true,result:{jwt:'fixture-upload-token',buckets:[Object.values(manifest).map(file => file.hash)]}});
    }
    return Response.json({success:true,result:{jwt:'fixture-completion-token'}});
  }});
  assert.equal(await uploadAssets(api,'browser-assets',files),'fixture-completion-token');
  assert.deepEqual(calls.map(request => request.url),[`${origin}/workers/scripts/browser-assets/assets-upload-session`,`${origin}/workers/assets/upload?base64=true`]);
  assert(calls.every(request => request.method === 'POST'));
  const [session,upload] = calls;
  assert.equal(session.headers.get('Authorization'),'Bearer fixture-account-token');
  const {manifest} = await session.json();
  assert.deepEqual(Object.keys(manifest),cases.map(file => `/${file.path}`));
  for (const file of cases) assert.equal(manifest[`/${file.path}`].size,Buffer.byteLength(file.bytes));
  assert.equal(upload.headers.get('Authorization'),'Bearer fixture-upload-token');
  assert.match(upload.headers.get('Content-Type'),/^multipart\/form-data; boundary=/);
  // Round-trip serialized bytes so assertions cover the actual multipart headers.
  const multipart = new Response(await upload.arrayBuffer(),{headers:upload.headers});
  const parts = await multipart.formData();
  assert.equal([...parts.keys()].length,cases.length);
  for (const file of cases) {
    const part = parts.get(manifest[`/${file.path}`].hash);
    assert(part,`missing upload part for ${file.path}`);
    assert.equal(part.name,file.path.split('/').at(-1));
    assert.equal(part.type,file.type,`upload MIME for ${file.path}`);
    assert.equal(await part.text(),Buffer.from(file.bytes).toString('base64'));
  }
});
