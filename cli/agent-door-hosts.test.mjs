import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { checkAgentDoor } from './agent-door.mjs';

test('native journey admits only declared deployment hosts and preserves the second URL and Host', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed');
 await buildFixture(root);
 const deploymentFile = join(root, 'deploy.json'), surfaceFile = join(root, 'agent-surface.json');
 const deployment = JSON.parse(await readFile(deploymentFile, 'utf8'));
 deployment.vars.STATUS_HOST = 'status.rer-hosted-check.invalid';
 deployment.vars.OTHER_HOST = 'other.rer-hosted-check.invalid';
 await writeFile(deploymentFile, JSON.stringify(deployment));
 // The real fixture Worker still drives authentication and all tool effects.
 // Its ingress refuses any disagreement between URL, Host and deployment var.
 await writeFile(join(root, 'dist/server/host-entry.mjs'), `import worker from './index.js';
 export default {...worker, fetch(request, env, context) {
  const url = new URL(request.url);
  if (url.pathname === '/' && (url.hostname !== env.STATUS_HOST || request.headers.get('host') !== env.STATUS_HOST || url.search !== '?native=1')) return new Response('Wrong public host', {status: 421});
  return worker.fetch(request, env, context);
 }};`);
 const configFile = join(root, 'dist/server/wrangler.json'), config = JSON.parse(await readFile(configFile, 'utf8'));
 config.main = 'host-entry.mjs';
 await writeFile(configFile, JSON.stringify(config));
 await writeFile(join(root, 'hosts-journey.mjs'), `import assert from 'node:assert/strict';
 export default async function ({request, origin}) {
  for (const refused of ['https://other.rer-hosted-check.invalid/app', 'http://status.rer-hosted-check.invalid/app', 'https://status.rer-hosted-check.invalid:444/app', 'https://status.rer-hosted-check.invalid.attacker.invalid/app', 'https://user@status.rer-hosted-check.invalid/app']) {
   await assert.rejects(async () => request(refused), {code:'agent_door_origin'});
  }
  const response = await request('https://status.rer-hosted-check.invalid/?native=1');
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type')?.startsWith('text/html'));
  await response.body?.cancel();
  const primary = await request(new URL('/health', origin).href);
  assert.equal(primary.status, 200);
  await primary.body?.cancel();
 }`);
 const surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 surface.verification.journey = 'hosts-journey.mjs';
 surface.verification.publicHosts = ['STATUS_HOST'];
 await writeFile(surfaceFile, JSON.stringify(surface));
 const admitted = await checkAgentDoor(root, { report() {} });
 assert.equal(admitted.ok, true);
 assert.ok(admitted.points.some(point => point.id === 'BASE-AGENT-013.native-journey' && point.ok));
 // Removing the explicit admission must refuse even though vars still names it.
 delete surface.verification.publicHosts;
 await writeFile(surfaceFile, JSON.stringify(surface));
 await assert.rejects(checkAgentDoor(root, { report() {} }), error => error.code === 'agent_door_failed'
  && error.agentDoor.points.some(point => point.id === 'BASE-AGENT-013.native-journey' && !point.ok));
});

test('host admission refuses malformed declarations and undeclared deployment variables before installation', { timeout: 30000 }, async t => {
 const root = await fixtureSeed(t, 'signed');
 const file = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(file, 'utf8'));
 const deploymentFile = join(root, 'deploy.json'), deployment = JSON.parse(await readFile(deploymentFile, 'utf8'));
 for (const hosts of ['STATUS_HOST', [null], ['MISSING_HOST'], ['STATUS_HOST', 'STATUS_HOST']]) {
  surface.verification.publicHosts = hosts;
  await writeFile(file, JSON.stringify(surface));
  await assert.rejects(checkAgentDoor(root, { report() {} }), { code: 'agent_hosts_invalid' });
 }
 surface.verification.publicHosts = ['STATUS_HOST'];
 await writeFile(file, JSON.stringify(surface));
 for (const host of ['https://status.example.invalid', 'status.example.invalid:443', 'status.example.invalid/path', '*.example.invalid', 'STATUS.example.invalid', 'status.example.invalid@other.example.invalid']) {
  deployment.vars.STATUS_HOST = host;
  await writeFile(deploymentFile, JSON.stringify(deployment));
  await assert.rejects(checkAgentDoor(root, { report() {} }), { code: 'agent_hosts_invalid' });
 }
});
