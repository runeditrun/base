import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { checkAgentDoor } from './agent-door.mjs';

const core = ['tools', 'policy', 'pause', 'audit', 'idempotency'];
const run = root => checkAgentDoor(root, { report() {} });
async function edit(root, mutate) {
 const path = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(path, 'utf8'));
 mutate(surface); await writeFile(path, JSON.stringify(surface));
}
async function coreFixture(t, capabilities) {
 const root = await fixtureSeed(t, 'signed', { capabilities });
 await edit(root, surface => {
  if (!capabilities.includes('events')) {
   surface.tools = surface.tools.filter(tool => !tool.name.endsWith('.events.list'));
   surface.journey = surface.journey.filter(step => !step.tool.endsWith('.events.list'));
  }
  if (!capabilities.includes('resources')) surface.resources = [];
 });
 await buildFixture(root); return root;
}

test('declared core and core plus events prove every offered check and refuse the rest through the production door', { timeout: 240000 }, async t => {
 for (const capabilities of [core, [...core, 'events'], [...core, 'events', 'resources', 'subscriptions']]) {
  const root = await coreFixture(t, capabilities), result = await run(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.capabilities.declared, capabilities);
  assert.ok(result.points.some(point => point.id.startsWith('BASE-AGENT-subset.refused.')));
  for (const family of ['BASE-AGENT-004.', 'BASE-AGENT-007.', 'BASE-AGENT-009.', 'BASE-AGENT-011.', 'BASE-AGENT-012.']) assert.ok(result.points.some(point => point.id.startsWith(family)));
  assert.equal(result.points.some(point => point.id === 'BASE-AGENT-010.2.events'), capabilities.includes('events'));
  t.diagnostic(`${capabilities.join('+')}: ${result.points.length}/${result.points.length} public-door points`);
  if (!capabilities.includes('events')) {
   await edit(root, surface => { delete surface.capabilities; });
   await assert.rejects(run(root), error => error.code === 'agent_door_failed' && error.agentDoor.points.some(point => !point.ok && point.id.endsWith('.events')));
   t.diagnostic('Without declaration: legacy full-set event requirement still fails.');
  } else {
   const deploy = join(root, 'deploy.json'), config = JSON.parse(await readFile(deploy, 'utf8'));
   config.vars.AGENT_CAPABILITIES = JSON.stringify(core); await writeFile(deploy, JSON.stringify(config));
   await assert.rejects(run(root), error => error.code === 'agent_door_failed' && error.agentDoor.points.some(point => !point.ok && point.id === 'BASE-AGENT-002.1.registry'));
   t.diagnostic('Declared events with missing runtime implementation: full event checks fail.');
  }
 }
});

test('a declaration cannot omit or disable any mandatory security duty', { timeout: 60000 }, async t => {
 const root = await coreFixture(t, core);
 for (const duty of core) {
  await edit(root, surface => { surface.capabilities = core.filter(name => name !== duty); });
  await assert.rejects(run(root), error => error.code === 'agent_door_failed' && error.agentDoor.points.some(point => !point.ok && point.id === 'BASE-AGENT-subset.declaration'));
 }
 await edit(root, surface => { surface.capabilities = { tools: true, policy: false }; });
 await assert.rejects(run(root), error => error.code === 'agent_door_failed');
});
