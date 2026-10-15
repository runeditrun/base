import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Runs only in the disposable, committed export created by verify-export.mjs.
export async function verifyInstaller(root,answers={}) {
 await assert.rejects(access(join(root, 'node_modules')));
 const { startInstaller } = await import(pathToFileURL(join(root, 'scripts/base-onboarding/server.mjs')));
 const { appFetch } = await import(pathToFileURL(join(root, 'scripts/base-onboarding/app-fetch.mjs')));
 const { createSeed } = await import(pathToFileURL(join(root, 'scripts/installer/seed.mjs')));
 const installer = await startInstaller(root, { seed: createSeed(root) });
 try {
  const page = await fetch(installer.origin);
  const html = await page.text();
  const token = /name="installer-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(token, 'installer bootstrap token');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'x-installer-token': token, Origin: installer.origin, 'Content-Type': 'application/json' };
  const state = await (await fetch(installer.origin + '/api/state', { headers })).json();
  assert.equal(state.draft.APP_NAME,JSON.parse(await readFile(join(root,'src/branding.json'),'utf8')).name);
  assert.equal(state.draft.ownerName, undefined);
  assert.equal(state.draft.email, undefined);
  const background = await fetch(installer.origin + '/ocean.png');
  assert.equal(background.headers.get('content-type'), 'image/svg+xml');
  assert.match(await background.text(), /<svg/);
  const started = await fetch(installer.origin + '/api/start', { method: 'POST', headers, body: JSON.stringify({ APP_NAME: 'My first application', PRIMARY_COLOR: '#356c60', displayName: 'Foundation Owner', OWNER_EMAIL: 'foundation-owner@example.test',...answers }) });
  assert.equal(started.status, 202, await started.text());
  let result;
  for (let attempt = 0; attempt < 600; attempt++) {
   result = await (await fetch(installer.origin + '/api/state', { headers })).json();
   if (['complete', 'failed'].includes(result.phase)) break;
   await delay(500);
  }
  assert.equal(result.phase, 'complete', result.error || result.step);
  // Saved state holds no key: the installer page asks /api/open-app for the
  // open link, then does what its exchange page script does in a browser,
  // trading the fragment key for the gate cookie before opening `next`.
  assert.equal(result.devOpen, true);
  const open = new URL((await (await fetch(installer.origin + '/api/open-app', { headers })).json()).url), fragment = new URLSearchParams(open.hash.slice(1));
  assert.ok(!JSON.stringify(result).includes(fragment.get('rer-dev')), 'installer state holds no dev key');
  const cookies = new Map();
  const remember = response => {
   for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';')[0], split = pair.indexOf('=');
    cookies.set(pair.slice(0, split), pair.slice(split + 1));
   }
  };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const traded = await appFetch(new URL('/__dev/key', open.origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: fragment.get('rer-dev') }) });
  assert.equal(traded.status, 204, 'the open link trades its key for the gate cookie');
  remember(traded);
  const next = fragment.get('next') ?? `/auth/dev/enter?as=${encodeURIComponent(fragment.get('as') ?? 'owner')}`;
  const entered = await appFetch(new URL(next, open.origin), { redirect: 'manual', headers: { cookie: cookieHeader() } });
  assert.equal(entered.status, 303, 'the one-click link signs in the owner');
  remember(entered);
  const session = await appFetch(new URL('/auth/session', open.origin), { headers: { cookie: cookieHeader() } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).operator.email, 'foundation-owner@example.test');
  const app = await appFetch(new URL('/setup', open.origin), { headers: { cookie: cookieHeader() } });
  assert.equal(app.status, 200);
  assert.match(await app.text(), /Foundation Owner/);
  assert.equal((await appFetch(new URL('/__dev/outbox', open.origin), { headers: { cookie: cookieHeader() } })).status, 404);
  assert.match(await (await appFetch(open.origin)).text(), /My first application/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'src/branding.json'))), { name: 'My first application', primaryColor: '#356c60' });
  console.log('Standalone predependency onboarding approved once, installed, built and served personalized real Worker');
 } finally { await installer.close(); }
}
