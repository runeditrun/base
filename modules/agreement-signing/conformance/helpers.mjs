export const profiles = Object.freeze(['text-terms', 'pdf-html-signature']);

export function check(value, message) {
  if (!value) throw new Error(message);
}

export function equal(actual, expected, message) {
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  check(JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected)), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

export async function success(promise) {
  const result = await promise;
  check(result.status >= 200 && result.status < 300, `Command failed (${result.status}): ${JSON.stringify(result.body)}`);
  return result.body;
}

export async function refused(promise, codes) {
  const result = await promise;
  check(result.status >= 400 && result.status < 500, `Expected refusal, received ${result.status}: ${JSON.stringify(result.body)}`);
  if (codes) check(codes.includes(result.body.code), `Unexpected refusal ${JSON.stringify(result.body)}; wanted ${codes.join(', ')}`);
  return result.body;
}

let nextKey = 0;
export function command(runtime, operation, input, actor = 'owner', key = `conformance-${++nextKey}`) {
  return runtime.command(operation, input, { actor, key });
}

export async function evidence(runtime, id, actor = 'owner') {
  return success(runtime.evidence(id, actor));
}

export async function current(runtime, id) {
  return (await evidence(runtime, id)).request;
}

export function version(request) { return { id: request.id, revision: request.revision }; }

export async function issue(runtime, replaces = null) {
  const request = await success(command(runtime, 'prepare', { sourceId: runtime.fixture.sourceId, replaces }));
  return success(command(runtime, 'issue', { id: request.id, revision: request.revision }));
}

export function credential(issued, recipientId) {
  return issued.invitations.find(item => item.recipientId === recipientId)?.token ?? null;
}

export async function review(runtime, issued, index, options = {}) {
  const request = await current(runtime, issued.request.id);
  const participant = runtime.fixture.participants[index];
  const binding = { ...runtime.fixture.binding, documentIds: request.definition.recipients[index].documentIds };
  const input = { request: { id: request.id, revision: request.revision }, recipientId: participant.recipientId,
    credential: credential(issued, participant.recipientId), binding: { ...binding, ...options.binding } };
  return { input, result: await runtime.command('review', input, { actor: options.actor ?? participant.actor, key: options.key ?? `review-${++nextKey}` }) };
}

export function redemption(issued, reviewed) {
  return { requestId: reviewed.requestId, recipientId: reviewed.recipientId,
    credential: credential(issued, reviewed.recipientId), token: reviewed.token, signableDigest: reviewed.signableDigest };
}

export async function sign(runtime, issued, index) {
  const reviewed = await success((await review(runtime, issued, index)).result);
  return success(command(runtime, 'sign', redemption(issued, reviewed), runtime.fixture.participants[index].actor));
}

export async function complete(runtime, issued) {
  let result;
  for (let index = 0; index < runtime.fixture.participants.length; index++) result = await sign(runtime, issued, index);
  return result;
}

export function bytes(base64) {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

export async function withRuntime(adapter, profile, run, options = {}) {
  const runtime = await adapter.open({ profile, ...options });
  try {
    for (const method of ['command', 'evidence', 'download', 'nativeState', 'reviseSource', 'rotateSession', 'revoke', 'failArtifactPut', 'close']) {
      check(typeof runtime?.[method] === 'function', `Conformance runtime requires ${method}().`);
    }
    check(runtime.fixture?.participants?.length >= 3, 'Fixture needs equal-order participants followed by a later participant.');
    const definition = runtime.fixture.definition;
    check(definition?.kind === (profile === 'text-terms' ? 'terms-acceptance' : 'electronic-signature'), 'Fixture must implement the declared evidence kind.');
    const media = definition.documents.map(document => document.mediaType.split(';')[0]);
    check(profile === 'text-terms' ? media.includes('text/plain') : media.includes('application/pdf') && media.includes('text/html'), 'Fixture must retain the declared actual media.');
    check(['supported', 'unsupported'].includes(runtime.fixture.externalExecution), 'Declare external execution support explicitly.');
    return await run(runtime);
  } finally {
    await runtime?.close?.();
  }
}
