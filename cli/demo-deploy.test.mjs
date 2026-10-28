import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './main.mjs';
import { demoProject } from './fixtures/demo-project.mjs';
import { demoEdge } from './fixtures/demo-edge.mjs';
import { demoAccount } from '../modules/demo-host/tests/demo-account.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';

test('rer deploy --demo redeploys its secret-rotated Worker and refuses a foreign or changed Worker', async t => {
 const { root, plan } = await demoProject(t), account = demoAccount(), saved = { ...process.env };
 t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
 Object.assign(process.env, { CI: 'true', WRANGLER_SEND_METRICS: 'false', RER_NO_UPDATE_CHECK: '1',
  CLOUDFLARE_ACCOUNT_ID: account.accountId, CLOUDFLARE_API_TOKEN: account.token,
  TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret-key' });
 await demoEdge(t, account, plan);
 const api = cloudflare({ accountId: account.accountId, token: account.token });
 const rotate = () => api.request(`/workers/scripts/${plan.worker}/secrets`, { method: 'PUT', body: { name: 'TURNSTILE_SECRET_KEY', text: 'test-rotated-key', type: 'secret_text' } });
 const deploy = async (json = false) => {
  let text = '';
  const captures = [process.stdout, process.stderr].map(stream => t.mock.method(stream, 'write', chunk => { text += String(chunk); return true; }));
  try { return { code: await main(['deploy', '--demo', '--cwd', root, '--environment', 'demo-test', ...(json ? ['--json'] : [])]), text }; }
  finally { for (const capture of captures) capture.mock.restore(); }
 };
 account.deploy(plan, { native: true }); account.unrelated();
 // Several rotations still have a contiguous history back to rer's record.
 await rotate(); await rotate();
 account.state.writes.length = 0;
 const before = account.state.workers.get(plan.worker).versions[0].id;
 const own = await deploy();
 assert.equal(own.code, 0, own.text);
 const script = account.state.workers.get(plan.worker);
 assert.notEqual(script.versions[0].id, before, 'real Wrangler uploaded a new version');
 assert.equal(script.deployments[0].versions[0].version_id, script.versions[0].id, 'the upload is served');
 assert.equal(script.versions[0].annotations['workers/message'], plan.record, 'the ordinary upload restores the ownership record');
 assert.ok(account.state.workers.has('someone-else'));
 assert.ok(!account.state.writes.some(write => write.startsWith('PATCH ') && write.includes('/settings')), 'inventory did not manufacture ownership with a settings write');
 // The next recovery uses a record actually written by that public deploy.
 await rotate();
 const repeated = await deploy(true);
 assert.equal(repeated.code, 0, repeated.text);

 const scriptNow = () => account.state.workers.get(plan.worker);
 const owned = structuredClone(account.state.workers.get(plan.worker));
 for (const [label, change] of [
  ['foreign unannotated Worker', () => { account.worker(plan.worker, undefined); }],
  ['foreign marked Worker', () => { account.worker(plan.worker, 'Deploy from the dashboard'); }],
  ['different code', () => { scriptNow().versions[0].resources.script.etag = 'different-script'; }],
  ['different binding', () => { scriptNow().versions[0].resources.bindings.push({ name: 'FOREIGN_DB', type: 'd1', id: 'other-database' }); }],
  ['different runtime', () => { scriptNow().versions[0].resources.script_runtime.compatibility_flags.push('foreign-flag'); }],
  ['foreign intervening version', () => { scriptNow().versions[1].annotations = { 'workers/message': 'foreign' }; }],
  ['undeployed successor', () => { scriptNow().versions.unshift({ ...structuredClone(scriptNow().versions[0]), id: owned.versions[1].id }); }],
 ]) {
  account.state.workers.set(plan.worker, structuredClone(owned));
  await rotate(); await change(); account.state.writes.length = 0;
  const snapshot = JSON.stringify([...account.state.workers]);
  const refused = await deploy(label === 'different binding');
  assert.equal(refused.code, 1, `${label}: ${refused.text}`);
  assert.ok(refused.text.includes(`resource-name-collision worker:${plan.worker}`), refused.text);
  if (label !== 'foreign marked Worker') assert.match(refused.text, /no workers\/message ownership annotation/);
  assert.match(refused.text, /restore|Restore/);
  assert.match(refused.text, /--environment/);
  assert.doesNotMatch(refused.text, /Building the native demo Worker bundle and static assets failed/);
  assert.deepEqual(account.state.writes, [], `${label}: no provider writes`);
  assert.equal(JSON.stringify([...account.state.workers]), snapshot, `${label}: Worker kept`);
 }
});
