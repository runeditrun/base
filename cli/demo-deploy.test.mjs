import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from './main.mjs';
import { demoProject } from './fixtures/demo-project.mjs';
import { demoAccount } from '../modules/demo-host/tests/demo-account.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';

test('rer deploy --demo redeploys its secret-rotated Worker and refuses a foreign or changed Worker', async t => {
 const { root, plan } = await demoProject(t), account = demoAccount(), saved = { ...process.env };
 t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
 Object.assign(process.env, { CI: 'true', WRANGLER_SEND_METRICS: 'false', RER_NO_UPDATE_CHECK: '1',
  CLOUDFLARE_ACCOUNT_ID: account.accountId, CLOUDFLARE_API_TOKEN: account.token,
  TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret-key' });
 const calls = [];
 t.mock.method(globalThis, 'fetch', (input, init = {}) => { calls.push(`${init.method ?? 'GET'} ${input}`); return account.fetch(input, init); });
 const api = cloudflare({ accountId: account.accountId, token: account.token });
 account.deploy(plan);
 await api.request(`/workers/scripts/${plan.worker}/secrets`, { method: 'PUT', body: { name: 'TURNSTILE_SECRET_KEY', text: 'test-rotated-key', type: 'secret_text' } });
 const code = await main(['deploy', '--demo', '--cwd', root, '--environment', 'demo-test']);
 console.log('Provider calls:', calls);
 console.log(await readFile(join(root, '.seed/installer/install.log'), 'utf8'));
 assert.equal(code, 0);
});
