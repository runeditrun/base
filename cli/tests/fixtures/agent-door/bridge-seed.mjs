import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureSeed } from './seed.mjs';

export async function document(root, name, change) {
 const path = join(root, name), value = JSON.parse(await readFile(path, 'utf8'));
 change(value);
 await writeFile(path, JSON.stringify(value));
}

export async function bridgeSeed(t, kind) {
 const root = await fixtureSeed(t, 'signed');
 await document(root, 'agent-surface.json', surface => {
  if (kind === 'queued') surface.verification.invoke = { module: 'invoke.mjs', entrypoint: 'NativeJobs' };
  if (kind === 'rpc') {
   surface.verification.rpc = { FIXTURE_EGRESS: { module: 'rpc-edge.mjs', entrypoint: 'Delivery' } };
   surface.tools.push({ name: 'fixture.records.dispatch', scope: 'records:write', readOnly: false, classes: ['external'], clauses: ['BASE-AGENT-006'] });
   surface.journey.splice(1, 0, { id: 'dispatch', tool: 'fixture.records.dispatch', args: { id: { $from: 'create', pointer: '/id' } }, expect: [{ class: 'external', facts: { measure: 1, counterparty: 'known' } }] });
  }
  if (kind === 'github') {
   surface.verification.owner.bindings.GITHUB_CONNECTION = { module: 'github-binding.mjs' };
   surface.tools.push({ name: 'fixture.github.claim', scope: 'records:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-002'] });
   surface.journey.push({ id: 'github', tool: 'fixture.github.claim', args: {}, expect: [{ class: 'standard' }] });
  }
  if (kind === 'lifecycle') surface.verification.journey = 'step-journey.mjs';
  if (kind === 'composite') {
   for (const [action, readOnly, classes] of [['prepare', false, ['access']], ['revoke', false, ['access']], ['grants', true, ['standard']]]) {
    const tool = { name: `fixture.members.${action}`, scope: readOnly ? 'records:read' : 'access:write', readOnly, classes, clauses: ['BASE-AGENT-005'] };
    if (action === 'revoke') Object.assign(tool, { widens: false, narrowing: { effect: 'revoke', target: ['team_id', 'operator_id'] }, inputSchema: { type: 'object', properties: { team_id: { type: 'string', minLength: 1 }, operator_id: { type: 'string', minLength: 1 } }, required: ['team_id', 'operator_id'], additionalProperties: false } });
    surface.tools.push(tool);
   }
   const args = { team_id: { $from: 'create', pointer: '/id' }, operator_id: 'teammate' };
   surface.journey.push(
    { id: 'prepare-team', tool: 'fixture.members.prepare', args, expect: [{ class: 'access', facts: { direction: 'widens' } }] },
    { id: 'team-grants', tool: 'fixture.members.grants', args, expect: [{ class: 'standard' }] },
    { id: 'revoke-team', tool: 'fixture.members.revoke', args, expect: [{ class: 'access', facts: { direction: 'narrows' } }] },
   );
   surface.escalations.push({ id: 'grant-self-team', tool: 'fixture.members.prepare', args: { team_id: { $from: 'create', pointer: '/id' }, operator_id: { $sponsor: 'id' } } });
   surface.narrowings.push({ tool: 'fixture.members.revoke', step: 'revoke-team', witness: { tool: 'fixture.members.grants', args, pointer: '/grants' } });
   surface.verification.journey = 'composite-journey.mjs';
  }
 });
 await document(root, 'deploy.json', deploy => { deploy.vars[`${kind.toUpperCase()}_PROOF`] = true; });
 if (kind === 'composite') await writeFile(join(root, 'composite-journey.mjs'), `export { default } from './journey.mjs';
export async function afterStep({ step, result, tool }) {
 if (step.id !== 'revoke-team') return;
 const answer = await tool('fixture.members.grants', result);
 if (answer.result?.structuredContent?.neighbors !== 2) throw new Error('Composite revoke changed neighboring grants');
}
`);
 if (kind === 'queued') await document(root, 'dist/server/wrangler.json', config => {
  config.queues = { producers: [{ binding: 'JOBS', queue: 'fixture-jobs' }], consumers: [{ queue: 'fixture-jobs', max_batch_size: 1, max_batch_timeout: 0, max_retries: 0 }] };
 });
 if (kind === 'rpc') await document(root, 'dist/server/wrangler.json', config => { config.services = [{ binding: 'FIXTURE_EGRESS', service: 'native-egress', entrypoint: 'Delivery' }]; });
 return root;
}
