import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runT016 } from '../t016/run.mjs';
import { validateFacts } from '../t016/facts.mjs';
import { publicSource, secretsFor } from '../t016/profile.mjs';
import { validateQualification } from '../t016/observations.mjs';
import { makeReceipt, validateReceipt } from '../receipt.mjs';
import { gmailMailbox } from '../../scripts/qualification/mailbox.mjs';
import { claimAndReply, sendAndReadMail } from '../../scripts/qualification/happytohelp.mjs';
import { fixture } from './helpers.mjs';
import { persistToGit } from '../git-store.mjs';
import { validateSource } from '../validate-source.mjs';
import { verifyMigrationTransition, selectTarget, r2DisabledReadback } from '../t016/cloudflare.mjs';

test('live runners fail closed before network without approved workflow and required inputs', async t => {
  const old = globalThis.fetch; globalThis.fetch = () => { throw new Error('network must not run'); }; t.after(() => globalThis.fetch = old);
  const local = await runT016('t016-r2-on', {});
  assert.equal(local.failure, 'live-environment-required'); validateQualification(local, 't016-r2-on');
  const missing = await runT016('t016-r2-on', { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'runeditrun/base', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.equal(missing.failure, 'missing-secret');
  assert.ok(secretsFor('t016-r2-on').includes('T016_SENDGRID_API_KEY'));
  assert.ok(!secretsFor('t016-r2-off').includes('T016_GMAIL_ACCESS_TOKEN'));
  assert.ok(!secretsFor('t016-r2-on').includes('OPENAI_API_KEY'));
});
test('strict receipt boundary rejects extra payloads, arbitrary commands, credentials and false pass', async () => {
  const report = await runT016('t016-r2-on', {});
  for (const value of [{ ...report, payload: 'private' }, { ...report, publicSource: { ...publicSource, repository: 'https://evil.test' } },
    { ...report, observations: [{ phase: 'owner', passed: true, sha256: 'token', utc: new Date().toISOString() }] },
    { ...report, commands: [{ argv: ['sh', '-c', 'secret'], startedUtc: new Date().toISOString(), finishedUtc: new Date().toISOString(), exitCode: 0, outputSha256: 'a'.repeat(64) }] },
    { ...report, failure: null, result: 'passed' }]) assert.throws(() => validateQualification(value, report.proof));
  const env = { VALIDATED_SHA: 'a'.repeat(40), CONTROL_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'runeditrun/base', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', MODE: 'proof', INPUT_PROOF: report.proof,
    JOB_RESULT: 'failure', EXECUTION_RESULT: 'proof-failed', EXECUTED_SHA: 'a'.repeat(40), QUALIFICATION: JSON.stringify(report) };
  const receipt = makeReceipt(env); assert.equal(receipt.result, 'failed'); validateReceipt(receipt);
  const incomplete = makeReceipt({ ...env, EXECUTION_RESULT: 'passed', JOB_RESULT: 'success', QUALIFICATION: '' });
  assert.equal(incomplete.result, 'failed'); validateReceipt(incomplete);
});
test('T016 failures persist to their own task route and mismatched controller SHA is refused', async t => {
  const f = fixture(t), report = await runT016('t016-r2-on', {});
  const receipt = makeReceipt({ VALIDATED_SHA: f.sha, CONTROL_SHA: f.sha, GITHUB_REPOSITORY: 'runeditrun/base', GITHUB_RUN_ID: '124', GITHUB_RUN_ATTEMPT: '1', MODE: 'proof', INPUT_PROOF: report.proof,
    JOB_RESULT: 'failure', EXECUTION_RESULT: 'proof-failed', EXECUTED_SHA: f.sha, QUALIFICATION: JSON.stringify(report) });
  assert.equal(persistToGit(receipt, { remote: f.remote, tempRoot: f.root }), '3-foundation/T-016/runeditrun--base/live-proof/124-1.json');
  assert.throws(() => validateSource({ cwd: f.controller, sha: f.sha, dispatchSha: 'b'.repeat(40), dispatchRef: 'refs/heads/main', event: 'workflow_dispatch', repo: 'runeditrun/base', mode: 'proof', proof: 't016-r2-on', remote: f.remote }), /controller-source-mismatch/);
});
test('Gmail requires mailbox identity and reads only new matching provider mail', async t => {
  const old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  let messages = [], calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    const value = url.endsWith('/profile') ? { emailAddress: 'proof@example.test' } : url.includes('format=full') ? {
      internalDate: '200', payload: { headers: [{ name: 'To', value: 'proof@example.test' }, { name: 'From', value: 'Qualification t016-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa <sender@example.test>' }, { name: 'Subject', value: 'HappyToHelp email verification' }, { name: 'Message-ID', value: '<fixture-message>' }], body: { data: Buffer.from('Your configured HappyToHelp email provider delivered this verification message.').toString('base64url') } },
    } : { messages };
    return Response.json(value);
  };
  const mailbox = gmailMailbox({ token: 'test-only-token', address: 'proof@example.test' });
  const before = await mailbox.snapshot(); messages = [{ id: 'abc123' }];
  const receipt = await mailbox.readNew(before, 'sender@example.test', 100, 't016-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.match(receipt.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.mailboxMessageId, 'abc123');
  assert.equal(receipt.messageId, '<fixture-message>');
  validateFacts('mailbox', receipt);
  assert(!JSON.stringify(receipt).includes('test-only'));
  assert.ok(calls.every(url => url.startsWith('https://gmail.googleapis.com/')));
  await assert.rejects(gmailMailbox({ token: 'test-only-token', address: 'other@example.test' }).snapshot(), /identity-mismatch/);
});
test('owner claim failure and missing durable reply fail the journey', async t => {
  const old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  globalThis.fetch = async () => Response.json({ available: false, tokenRequired: true });
  await assert.rejects(claimAndReply({ origin: 'https://fixture.example', env: {}, observe() {} }), /fresh-token/);
  globalThis.fetch = async url => url.endsWith('/setup') ? Response.json({ available: true, tokenRequired: true }) : Response.json({}, { status: 403 });
  await assert.rejects(claimAndReply({ origin: 'https://fixture.example', env: {}, observe() {} }), /http-status/);
  let claimed = false, messageCount = 0;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/setup')) return Response.json({ available: !claimed, tokenRequired: true });
    if (path.endsWith('/bootstrap')) { claimed = true; return Response.json({ projectId: 'project', userId: 'owner', token: 'test-owner' }, { status: 201 }); }
    if (path === '/api/identity/session') return Response.json({ projectId: 'project', id: 'owner', role: 'owner' });
    if (path.endsWith('/projects/project')) return Response.json({ widget_key: 'test-widget' });
    if (path.endsWith('/widget/session')) return Response.json({ token: 'test-visitor' }, { status: 201 });
    if (path === '/api/conversations') return Response.json({ id: 'conversation' }, { status: 201 });
    if (path.startsWith('/api/dashboard/')) return Response.json({ data: [{ id: 'conversation' }] });
    if (path.endsWith('/messages') && options.method === 'POST') { messageCount++; return Response.json({ accepted: true, message: { id: 'message-' + messageCount, revision: messageCount, actor_role: messageCount === 2 ? 'owner' : 'contact' } }); }
    return Response.json({ messages: [], revision: 0 });
  };
  await assert.rejects(claimAndReply({ origin: 'https://fixture.example', env: {}, observe() {},
    browser: async () => ({ conversationId: 'conversation', requestContent: 'request', replyContent: 'reply',
      reply: { visitorMessageId: 'message-1', operatorMessageId: 'message-2' }, widget: {}, media: {} }) }), /reply-readback-failed/);
});
test('SendGrid rejection fails without mailbox success; missing mail cannot pass', async t => {
  const old = globalThis.fetch, timer = globalThis.setTimeout;
  t.after(() => { globalThis.fetch = old; globalThis.setTimeout = timer; });
  const env = { T016_MAILBOX_ADAPTER: 'gmail', T016_GMAIL_ACCESS_TOKEN: 'test-only', T016_TEST_MAILBOX: 'proof@example.test', T016_SENDGRID_FROM: 'sender@example.test' };
  globalThis.fetch = async (url, options) => {
    if (url.includes('gmail.googleapis.com')) return Response.json(url.endsWith('/profile') ? { emailAddress: env.T016_TEST_MAILBOX } : {});
    if (url.endsWith('/test')) return Response.json({}, { status: 502 });
    return Response.json(options.method === 'PUT' ? { updated: true } : { configured: true });
  };
  await assert.rejects(sendAndReadMail({ origin: 'https://fixture.example', env, state: { owner: { token: 'test-only', projectId: 'project' } }, observe() { assert.fail('No success observation should exist'); }, deliveryReadback() { assert.fail('No durable readback after rejection'); } }), /http-status/);
  globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
  const mailbox = gmailMailbox({ token: 'test-only', address: env.T016_TEST_MAILBOX });
  await assert.rejects(mailbox.readNew(new Set(), env.T016_SENDGRID_FROM, Date.now(), 't016-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /mailbox-message-absent/);
});
test('workflow exposes mail secrets only to full T016 proofs, keeps writer separate', () => {
  const workflow = readFileSync('.github/workflows/live-proof.yml', 'utf8');
  const execute = workflow.split('  execute:')[1].split('  receipt:')[0], receipt = workflow.split('  receipt:')[1];
  for (const name of ['T016_SENDGRID_API_KEY', 'T016_SENDGRID_FROM', 'T016_TEST_MAILBOX', 'T016_GMAIL_ACCESS_TOKEN']) {
    const secret = name === 'T016_SENDGRID_API_KEY' ? 'SENDGRID_API_KEY' : name;
    const selection = name === 'T016_GMAIL_ACCESS_TOKEN' ? "vars.T016_MAILBOX_ADAPTER == 'gmail' && " : '';
    assert.ok(execute.includes(name + ": ${{ (inputs.proof == 't016-r2-on' || inputs.proof == 't016-upgrade-rollback') && " + selection + 'secrets.' + secret));
    assert.ok(!receipt.includes('secrets.' + name));
    assert.ok(!receipt.includes('secrets.' + secret));
  }
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|toJSON\(secrets\)/);
  assert(workflow.includes('&& secrets.SENDGRID_API_KEY'));
  assert(!workflow.includes('secrets.T016_SENDGRID_API_KEY'));
  const gate = workflow.split('  isolation:')[1].split('  execute:')[0];
  assert(!gate.includes('secrets.')); assert(!gate.includes('environment:'));
  assert(workflow.includes('T016_ISOLATION_ATTESTATION:'));
  assert(workflow.includes("vars.T016_MAILBOX_ADAPTER == 'gmail'"));
});
test('metadata-only release migration application preserves ledger; loss or rollback rewrite fails', () => {
  const before = [{ name: '0001_initial.sql' }];
  assert.doesNotThrow(() => verifyMigrationTransition(before, structuredClone(before)));
  assert.doesNotThrow(() => verifyMigrationTransition(before, structuredClone(before), true));
  assert.throws(() => verifyMigrationTransition(before, [{ name: '0002_other.sql' }]), /history-changed/);
  assert.throws(() => verifyMigrationTransition(before, [...before, { name: '0002_added.sql' }], true), /history-changed/);
  assert.throws(() => verifyMigrationTransition([], []), /invalid-migration/);
});
test('throwaway target requires a specific-script 404, never a missing list entry', async t => {
  const old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-only' };
  let status = 200;
  globalThis.fetch = async url => url.endsWith('/workers/subdomain') ? Response.json({ success: true, result: { subdomain: 'throwaway' } }) : new Response('', { status });
  await assert.rejects(selectTarget(env, 't016-123-1'), /not-confirmed-absent/);
  status = 403; await assert.rejects(selectTarget(env, 't016-123-1'), /not-confirmed-absent/);
  status = 404; assert.equal(await selectTarget(env, 't016-123-1'), 'https://t016-123-1.throwaway.workers.dev');
  await assert.rejects(selectTarget(env, '../production'), /invalid-target-prefix/);
});
test('R2-off capture requires a real disabled-product error, not an arbitrary failed request', async t => {
  const old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-only' };
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ message: 'Token permission denied' }] }, { status: 403 });
  await assert.rejects(r2DisabledReadback(env), /not-observed/);
  globalThis.fetch = async () => Response.json({ success: true, result: [] });
  await assert.rejects(r2DisabledReadback(env), /not-observed/);
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 10042, message: 'Please enable R2 through the dashboard' }] }, { status: 400 });
  assert.deepEqual(await r2DisabledReadback(env), { status: 400, code: 10042 });
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 10042, message: 'Enable R2 to continue' }] }, { status: 403 });
  assert.deepEqual(await r2DisabledReadback(env), { status: 403, code: 10042 });
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ message: 'Enable R2 to continue' }] }, { status: 403 });
  await assert.rejects(r2DisabledReadback(env), /error-code/);
});
