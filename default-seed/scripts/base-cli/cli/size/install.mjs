import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RerError } from '../errors.mjs';
import { serveHosted } from '../hosted-output.mjs';
import { bootstrapOwner, hostedRequest, ownerBindings, ownerClaim, ownerKeys, ownerSession, reviewerDoor } from '../hosted-owner.mjs';
import { verificationReviewers } from '../agent-reviewers.mjs';
import { readAgentSurface } from '../agent-surface.mjs';
import { verificationSponsors } from '../agent-sponsors.mjs';
import { FixtureError, compileFixture, failureColumn, fixtureParameters, sizes } from './fixture.mjs';
import { createMeter } from './meter.mjs';

// One disposable install per size: the build served as verify's hosted check serves it (a fresh local D1 with the
// build's migrations), the owner signed in with the bootstrap agent-door conformance uses, the shape generated
// inside D1 by the compiled statements, then the declared tables read back and the install closed.

// A declaration that cannot be compiled is a declaration problem, not an unexpected failure.
const compiling = work => { try { return work(); } catch (error) { throw error instanceof FixtureError ? new RerError('size_declaration_invalid', `The size declaration cannot be built: ${error.message}`, 1) : error; } };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const ownerClaimModes = ['setup-token', 'signed'];
const refuseNetwork = async () => new Response('rer size installs refuse outbound network.', { status: 502 });

/** What every install of one run shares: the declaration, who the owner is and how to sign them in, the database
 * binding and the run's start time. Refuses a declaration that needs the owner when the seed declares no way to
 * create one. */
export async function prepareRun(root, declaration, { project, now = Date.now() } = {}) {
 const verification = (await readAgentSurface(root))?.surface.verification ?? {};
 const wantsOwner = Object.values(declaration.personas ?? {}).some(persona => persona.kind === 'owner') || compiling(() => fixtureParameters(declaration)).has('owner_email');
 const run = { root, declaration, verification, now, project };
 const wrangler = await readJson(join(root, 'dist/server/wrangler.json')).catch(() => ({}));
 const bindings = (wrangler.d1_databases ?? []).map(item => item.binding);
 run.binding = declaration.database ?? (bindings.length === 1 ? bindings[0] : undefined);
 if (!run.binding) throw new RerError('size_database_missing', bindings.length ? `The build declares several D1 bindings (${bindings.join(', ')}); set "database" in size-check.json.` : 'This build has no D1 database to generate the shape in.', 1);
 const adapter = project?.adapter;
 run.deployDeclaration = adapter ? adapter.deployDeclaration ?? adapter.deploy?.declaration ?? declaration.build.deployDeclaration : declaration.build.deployDeclaration;
 if (wantsOwner) await prepareOwner(run);
 // Both sizes compile before the first is built, so a mistake in the large size does not wait for the small one.
 run.fixtures = Object.fromEntries(sizes.map(size => [size, compiling(() => compileFixture(declaration, size, { now, ownerEmail: run.owner?.email }))]));
 return run;
}

async function prepareOwner(run) {
 const { root, verification, project } = run, adapter = project?.adapter;
 const manifest = project?.setupManifest ?? await readJson(join(root, 'rer-setup.json')).catch(() => ({}));
 const claim = manifest.steps?.find(step => step.type === 'owner-claim');
 if (!claim && verification.owner === undefined) throw new RerError('size_owner_missing', 'The declaration needs the owner (an owner persona or :owner_email) and this seed declares no way to create one: add an owner-claim step to rer-setup.json steps, or verification.owner to agent-surface.json.', 1);
 // Only the first principal is the owner; extra sponsors belong to agent-door conformance.
 const sponsors = Array.isArray(verification.sponsors) ? verification.sponsors.slice(0, 1).map(({ negativeOnly, ...rest }) => rest) : verification.sponsors;
 const [native] = await verificationSponsors(root, { ...verification, sponsors });
 if (claim?.mode && !ownerClaimModes.includes(claim.mode) && !native.initialize) throw new RerError('agent_owner_invalid', `Owner claim mode ${claim.mode} requires verification.owner.initializer using the seed's production lifecycle.`, 1);
 if (verification.reviewers !== undefined && !native.initialize) throw new RerError('agent_reviewer_invalid', 'verification.reviewers requires a native owner initializer to drive invitation and independent review.', 1);
 run.owner = { native, claim, hook: adapter?.hooks?.owner, email: native.email, sub: native.sub };
}

/** The error a failed statement becomes: the size, the table, the row range, SQLite's message and its column. */
function generationError(size, part, error) {
 if (error instanceof RerError && error.code === 'size_timeout') return error;
 const message = String(error?.diagnosis ?? error?.message ?? error).replace(/^D1_ERROR:\s*/, '').replace(/:\s*SQLITE_\w+(?: \(extended: \w+\))?\s*$/, '');
 const column = failureColumn(message);
 const where = part.kind === 'rows' ? `table ${part.table}, rows ${part.first.toLocaleString('en-US')}-${part.last.toLocaleString('en-US')}` : `after statement ${part.index}`;
 return new RerError('size_generation_failed', `Generating the ${size} size failed in ${where}${column ? `, column ${column}` : ''}: ${message}`, 1, { size, table: part.table, first: part.first, last: part.last, column, sqlite: message });
}

// The bootstrap agent-door uses: the seed's owner initializer when it declares one, else its owner claim. The
// initializer gets the declared native reviewers, as in conformance; it gets no mail or fixtures, which only the
// conformance network provides.
async function signOwnerIn(run, hosted, keys) {
 const { native, claim, hook, email, sub } = run.owner, request = hostedRequest(hosted);
 const reviewers = await verificationReviewers(run.root, run.verification.reviewers, email);
 try {
  const { path, claimToken } = await ownerClaim({ claim, owner: hook, hosted, keys, email });
  let response;
  try { response = await bootstrapOwner({ hosted, request, native, claim, owner: hook, keys, email, sub, path, claimToken, extra: { reviewers: reviewerDoor(reviewers, { request, hosted, owner: hook }) } }); }
  catch (error) { throw new RerError('size_owner_failed', `rer size could not sign the owner in through the hosted origin: ${String(error?.message ?? error).slice(0, 300)}`, 1); }
  const { cookie, failure } = await ownerSession(response);
  if (failure) throw new RerError('size_owner_failed', `rer size could not sign the owner in: ${failure}`, 1);
  return { email, sub, cookie };
 } finally { reviewers.close(); }
}

const count = async (database, table) => Number(await database.prepare(`SELECT count(*) AS c FROM "${table}"`).first('c'));

/**
 * Builds one install at `size` and reads back what it holds. Resolves
 * `{ size, tables: [{ table, declared, before, readBack, total, ms }], totalRows, phases, measured }` (phases in ms)
 * and has closed the install; rejects with the first failure, naming where it stopped. With `measure`, the install
 * is served with the rows-read meter and, once built, `measure({ hosted, owner, meter, timed })` runs on it before it
 * closes; what it resolves is `measured`. `timed(phase, flow, work)` runs work under the run's clock and adds its
 * time to that phase.
 */
export async function buildInstall(run, size, clock, measure) {
 const { declaration } = run, phases = { serve: 0, owner: 0, generate: 0, after: 0, readback: 0, personas: 0, flows: 0 };
 const fixture = run.fixtures[size];
 const timed = async (phase, table, work, flow) => {
  clock.enter(size, phase, table, flow);
  const started = performance.now();
  try { return await clock.within(work()); } finally { phases[phase] += performance.now() - started; }
 };
 let keys, serving, hosted, owner, measured;
 const meter = measure ? createMeter() : undefined;
 try {
  if (run.owner) keys = await ownerKeys(run.root, run.owner.native, { email: run.owner.email, sub: run.owner.sub });
  serving = serveHosted(run.root, { declaration: run.deployDeclaration, publicHosts: run.verification.publicHosts, rpc: run.verification.rpc,
   fixturePreparation: true, fixtureDiagnostics: true, outboundService: refuseNetwork, meter,
   bindings: keys ? ownerBindings(keys, { claim: run.owner.claim, native: run.owner.native, email: run.owner.email }) : {} });
  hosted = await timed('serve', undefined, () => serving);
  if (keys) owner = await timed('owner', undefined, () => signOwnerIn(run, hosted, keys));
  const database = await (await hosted.preparation()).database(run.binding);
  const before = new Map();
  await timed('readback', undefined, async () => { for (const { table } of fixture.tables) before.set(table, await count(database, table)); });
  const ms = new Map(fixture.tables.map(({ table }) => [table, 0]));
  for (const [index, { sql, params }] of fixture.statements.entries()) {
   const part = fixture.parts[index], phase = part.kind === 'rows' ? 'generate' : 'after', started = performance.now();
   try { await timed(phase, part.table, () => database.prepare(sql).bind(...params).run()); }
   catch (error) { throw generationError(size, part, error); }
   if (part.kind === 'rows') ms.set(part.table, ms.get(part.table) + performance.now() - started);
  }
  const tables = [], names = [];
  let totalRows = 0;
  await timed('readback', undefined, async () => {
   for (const { table, rows } of fixture.tables) {
    const total = await count(database, table);
    tables.push({ table, declared: rows, before: before.get(table), readBack: total - before.get(table), total, ms: ms.get(table) });
   }
   const found = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all();
   names.push(...found.results.map(row => row.name));
   // A virtual table's shadow tables or a table SQLite cannot count are not rows the check made.
   for (const name of names) totalRows += await count(database, name).catch(() => 0);
  });
  if (measure) measured = await measure({ hosted, owner, meter, timed: (phase, flow, work) => timed(phase, undefined, work, flow) });
  return { size, tables, totalRows, phases, statements: fixture.statements.length, measured };
 } finally {
  clock.enter(size, 'closing the install');
  // A timeout can leave the install still starting: close it as soon as it exists.
  if (hosted) await hosted.close(); else serving?.then(late => late.close(), () => {});
 }
}
