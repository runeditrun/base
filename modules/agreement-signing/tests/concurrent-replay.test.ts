import test from 'node:test';
import assert from 'node:assert/strict';
import { openSigningRuntime } from './runtime.mjs';
import type { D1Database, D1Statement, IssueResult, OneUseReview, RequestRecord, ReviewRedemption, SigningResult } from '../types.ts';

// Delay only scheduling. Every SQL query, authority check and native write still
// runs against the consumer's real migrated D1 database and service adapters.
function pauseIntentRead(database: D1Database) {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  function statement(value: D1Statement): D1Statement {
    return {
      bind: (...params) => statement(value.bind(...params)),
      async first<T>() { enter(); await released; return value.first<T>(); },
      all: () => value.all(),
    };
  }
  return {
    entered,
    release: resume,
    database: {
      prepare(query: string) {
        const value = database.prepare(query);
        return query.startsWith('SELECT payload_digest,action FROM as_action_intents') ? statement(value) : value;
      },
      batch: (statements: D1Statement[]) => database.batch(statements),
    },
  };
}

type Runtime = Awaited<ReturnType<typeof openSigningRuntime>>;
async function command<T>(runtime: Runtime, operation: Parameters<Runtime['command']>[0], input: unknown, actor: string, key: string): Promise<T> {
  const result = await runtime.command(operation, input, { actor, key });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as T;
}
async function prepared(runtime: Runtime) {
  const request = await command<RequestRecord>(runtime, 'prepare', { sourceId: runtime.fixture.sourceId, replaces: null }, 'owner', 'prepare');
  const issued = await command<IssueResult>(runtime, 'issue', { id: request.id, revision: request.revision }, 'owner', 'issue');
  const person = runtime.fixture.participants[0];
  const credential = issued.invitations.find(item => item.recipientId === person.recipientId)?.token ?? null;
  const reviewed = await command<OneUseReview>(runtime, 'review', {
    request: { id: request.id, revision: issued.request.revision }, recipientId: person.recipientId, credential,
    binding: { ...runtime.fixture.binding, documentIds: request.definition.recipients[0].documentIds },
  }, person.actor, 'review');
  const input: ReviewRedemption = { requestId: request.id, recipientId: person.recipientId, credential,
    token: reviewed.token, signableDigest: reviewed.signableDigest };
  return { request, input, actor: person.actor };
}

for (const profile of ['text-terms', 'pdf-html-signature'] as const) {
  test(`concurrent signing recovers an intent consumed by the identical winner (${profile})`, { timeout: 30000 }, async t => {
    const runtime = await openSigningRuntime({ profile });
    const gate = pauseIntentRead(runtime.database);
    let pending: Promise<SigningResult> | undefined;
    try {
      const { input, actor } = await prepared(runtime);
      pending = runtime.signWithDatabase(input, { actor, key: 'sign-once' }, gate.database);
      // Observe rejection immediately, including on a failed regression run.
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await gate.entered;
      const winner = await command<SigningResult>(runtime, 'sign', input, actor, 'sign-once');
      assert.equal(await runtime.database.prepare('SELECT COUNT(*) AS n FROM as_action_intents').first().then(row => row?.n), 0);
      gate.release();
      const result = await outcome;
      if ('error' in result) t.diagnostic(`Delayed signer returned ${result.error.status} ${result.error.code}`);
      assert.ok('value' in result, 'The identical winner consumed the intent; recover its command instead of replay_mismatch');
      assert.deepEqual(result.value, winner);
      const native = await runtime.nativeState();
      assert.equal(native.body.actions.length, 1);
      assert.equal(native.body.completions.length, 0);
      t.diagnostic('Identical concurrent commands retained one act and one result after the winner deleted the intent.');
    } finally {
      gate.release();
      await pending?.catch(() => {});
      await runtime.close();
    }
  });
  test(`signing replay still refuses changed arguments and revision (${profile})`, { timeout: 30000 }, async t => {
    const runtime = await openSigningRuntime({ profile });
    try {
      const { request, input, actor } = await prepared(runtime);
      await command<SigningResult>(runtime, 'sign', input, actor, 'sign-once');
      const changedArgument = await runtime.command('sign', { ...input, signableDigest: 'a'.repeat(64) }, { actor, key: 'sign-once' });
      assert.deepEqual({ status: changedArgument.status, body: changedArgument.body }, { status: 409, body: { code: 'replay_mismatch', message: 'replay_mismatch' } });
      const changedRevision = await runtime.command('issue', { id: request.id, revision: request.revision + 1 }, { actor: 'owner', key: 'issue' });
      assert.deepEqual({ status: changedRevision.status, body: changedRevision.body }, { status: 409, body: { code: 'replay_mismatch', message: 'replay_mismatch' } });
      await runtime.revoke(actor);
      assert.equal((await runtime.command('sign', input, { actor, key: 'sign-once' })).status, 401);
      const native = await runtime.nativeState();
      assert.equal(native.body.actions.length, 1);
      assert.equal(native.body.completions.length, 0);
      t.diagnostic('Changed argument/revision = 409 replay_mismatch; revoked caller refused; native effects = 1.');
    } finally { await runtime.close(); }
  });
}
