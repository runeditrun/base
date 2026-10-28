import { runCases } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { declareEgress, validateEgressConfiguration } from '../../index.ts';

test('portable public entry graph imports no Node runtime while describing egress', async t => {
function declarationFixture() { return declareEgress({ id: 'incident-notifications', required: true,
    provider: { id: 'slack', name: 'Slack' }, destination: { kind: 'provider', id: 'slack-bot-v1', description: 'Authorized operations channel' },
    why: 'Operators use their Slack channel for alerts.', dataFields: ['incident title', 'public summary'],
    adapters: ['notifications.slack.v1'], custody: [{ name: 'SLACK_BOT_TOKEN', purpose: 'Posts as the installed Slack bot' }],
  }); }
  await runCases(t, [
['portable public module graph', async t => {

  const seen = new Set<string>();
  async function visit(url: URL) {
    if (seen.has(url.href)) return; seen.add(url.href);
    const source = await readFile(url, 'utf8');
    for (const match of source.matchAll(/^(?:import|export)\s+(?:[^\n;]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
      const dependency = match[1]!;
      assert.ok(dependency.startsWith('.'), `Nonportable dependency: ${dependency} in ${url.pathname}`);
      await visit(new URL(dependency, url));
    }
  }
  await visit(new URL('../../index.ts', import.meta.url));
  for (const entry of ['core/index.ts', 'slack/index.ts', 'egress/index.ts'])
    assert.ok(seen.has(new URL(`../../${entry}`, import.meta.url).href));
}],
['public egress declaration fields', async t => {
const declaration=declarationFixture();

  assert.deepEqual(Object.keys(declaration.external).sort(), ['adapters', 'data', 'id', 'required', 'why']);
}],
['public egress configuration', async t => {
const declaration=declarationFixture();

  assert.equal(validateEgressConfiguration(declaration, { providerId: 'slack', destinationId: 'slack-bot-v1', destinationUrl: 'https://slack.com/api/chat.postMessage', secrets: { SLACK_BOT_TOKEN: 'fixture-only' } }).destinationId, 'slack-bot-v1');
}],
['private egress configuration refuses', async t => {
const declaration=declarationFixture();

  assert.throws(() => validateEgressConfiguration(declaration, { providerId: 'slack', destinationId: 'slack-bot-v1', destinationUrl: 'https://127.0.0.1/', secrets: { SLACK_BOT_TOKEN: 'fixture-only' } }), /public HTTPS/);
}]
  ]);
});
