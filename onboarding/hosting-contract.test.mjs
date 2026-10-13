import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createState } from './state.mjs';
import { localInstaller, ownerAccountHosting } from './adapter.mjs';

// The hosting hook against the real Base deploy-kit owner CLI. In a seed's
// scripts/base-onboarding copy the CLI is elsewhere, so this runs only in Base.
const cli = fileURLToPath(new URL('../modules/deploy-kit/owner-cli.mjs', import.meta.url));

test('the hosting hook drives the real deploy-kit owner CLI with the chosen account and token', { skip: !existsSync(cli) && 'runs in Base beside modules/deploy-kit' }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'hosting-contract-'));
 const store = await createState(root, { product: 'Hosting contract', model: { safeKeys: [] } });
 t.after(async () => { await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 const kit = localInstaller({ tools: [], dependencies: false, features: { hosting: true }, hosting: ownerAccountHosting({ cli }) });
 await kit.install(root, { target: 'remote', accountId: 'a'.repeat(32), apiToken: 'test-synthetic-owner-token' }, store, () => {});
 assert.equal(store.state.phase, 'failed');
 const [headline, guidance] = store.state.error.split('\n');
 assert.equal(headline, 'Deploying to your Cloudflare account: exit 1, signal none.');
 assert.match(guidance, /^Installation stopped while deploying the application\./);
 // The CLI received both inputs and the argument shape, and stopped at the
 // absent declaration before any provider call.
 assert.match(store.state.error, /"code":"missing-owner-declaration"/);
 assert.ok(!store.state.error.includes('test-synthetic-owner-token'));
});
