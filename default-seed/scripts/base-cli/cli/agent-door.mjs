import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgentDoorConformance } from '../modules/agent-door/conformance/index.mjs';
import { validateAgentSurface } from '../modules/agent-door/conformance/surface.mjs';
import { seconds, signJws } from '../modules/agent-door/conformance/crypto.mjs';
import { readAgentSurface } from './agent-surface.mjs';
import { serveHosted } from './hosted-output.mjs';
import { bootstrapOwner, hostedRequest, ownerBindings, ownerClaim, ownerKeys, ownerSession, pairedBindings, reviewerDoor } from './hosted-owner.mjs';
import { createAgentConformanceNetwork } from './agent-network.mjs';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';
import { verificationReviewers } from './agent-reviewers.mjs';
import { verificationSponsors } from './agent-sponsors.mjs';
import { verificationWebhooks } from './agent-webhooks.mjs';
import { verificationInvoke, verificationJourney } from './agent-verifier.mjs';
import { writeVerificationHistory } from './agent-history-database.mjs';
import { verificationHistory } from './agent-history.mjs';
import { journeyFixtures } from './agent-journey-fixtures.mjs';
import { verificationAgentInitializer } from './agent-initializer.mjs';

function finish(result, report) {
 if (result.capabilities) report(`Agent capabilities (${result.capabilities.mode}): declared=${result.capabilities.declared.join(',')}; refused=${result.capabilities.refused.join(',')}; unscoped=${result.capabilities.unscoped.join(',')}.`);
 for (const point of result.points) report(`${point.ok ? 'PASS' : 'FAIL'} ${point.id}${point.ok || !point.detail ? '' : `: ${point.detail}`}`);
 const failed = result.points.filter(point => !point.ok).map(point => point.id);
 report(`Agent door conformance: ${result.points.length - failed.length}/${result.points.length} points passed.`);
 if (!result.ok) throw new RerError('agent_door_failed', `Agent door conformance failed: ${failed.join(', ')}.`, 1, { failures: failed, agentDoor: result });
 return { declared: true, ...result };
}

/** A fresh production installation and key ring for every conformance run. */
export async function checkAgentDoor(root, { declaration, setupManifest, owner, report = console.log } = {}) {
 const declared = await readAgentSurface(root);
 if (!declared) { report('Agent door conformance: undeclared (no agent-surface.json).'); return { declared: false }; }
 const surface = declared.surface;
 if (surface && typeof surface === 'object' && !Array.isArray(surface) && Object.keys(surface).length === 1
  && surface.verification && typeof surface.verification === 'object' && !Array.isArray(surface.verification)) {
  report('Agent door conformance: undeclared (verification-only agent-surface.json)');
  return { declared: false };
 }
 const validation = validateAgentSurface(surface, { contract: declared.contract });
 if (!validation.ok) return finish(validation, report);
 const manifest = setupManifest ?? JSON.parse(await readFile(join(root, 'rer-setup.json'), 'utf8'));
 const claim = manifest.steps?.find(step => step.type === 'owner-claim');
 const verification = declared.surface.verification ?? {};
 const initializeAgent = await verificationAgentInitializer(root, verification.agent);
 const workerDriver = await verificationInvoke(root, verification.invoke);
 let prove;
 if (verification.proof !== undefined) {
  if (typeof verification.proof?.module !== 'string' || Object.keys(verification.proof).join(',') !== 'module') throw new RerError('agent_proof_invalid', 'verification.proof must name a contained test module.', 1);
  await contained(root, verification.proof.module);
  prove = (await import(pathToFileURL(resolve(root, verification.proof.module)))).default;
  if (typeof prove !== 'function') throw new RerError('agent_proof_invalid', 'verification.proof module must default-export a native proof test function.', 1);
 }
 const negativeOnly = new Set();
 const sponsorDeclarations = Array.isArray(verification.sponsors) ? verification.sponsors.map((principal, index) => {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return principal;
  const { negativeOnly: probeOnly, ...declaration } = principal;
  if (probeOnly !== undefined && typeof probeOnly !== 'boolean' || probeOnly && index === 0) throw new RerError('agent_sponsors_invalid', 'Only additional verification sponsors may declare negativeOnly:true.', 1);
  if (probeOnly) negativeOnly.add(principal.label);
  return declaration;
 }) : verification.sponsors;
 const principals = await verificationSponsors(root, { ...verification, sponsors: sponsorDeclarations }), native = principals[0], { email, sub } = native;
 if (verification.reviewers !== undefined && !native.initialize) throw new RerError('agent_reviewer_invalid', 'verification.reviewers requires a native owner initializer to drive invitation and independent review.', 1);
 const reviewers = await verificationReviewers(root, verification.reviewers, email);
 if (claim?.mode && !['signed', 'setup-token'].includes(claim.mode) && !native.initialize) throw new RerError('agent_owner_invalid', `Owner claim mode ${claim.mode} requires verification.owner.initializer using the seed's production lifecycle.`, 1);
 const keys = await ownerKeys(root, native, { email, sub });
 const { token, kid, installationId, business, issuer, pair } = keys;
 const network = await createAgentConformanceNetwork(root, verification.network, { email, sponsorEmails: principals.slice(1).map(person => person.email) });
 let hosted, history;
 try {
 hosted = await serveHosted(root, { declaration, publicHosts: verification.publicHosts, fixturePreparation: true, rpc: verification.rpc, workerEntrypoints: workerDriver ? [workerDriver.entrypoint] : [], outboundService: async request => {
  const copy = reviewers.observes(request) ? request.clone() : null, response = await network.fetch(request);
  if (copy) await reviewers.capture(copy, response.clone());
  return response;
 }, bindings: {
  ...ownerBindings(keys, { claim, native, email }),
 } });
  const request = hostedRequest(hosted);
  const { path, claimToken } = await ownerClaim({ claim, owner, hosted, keys, email });
  let bootstrap;
  try {
   bootstrap = await bootstrapOwner({ hosted, request, native, claim, owner, keys, email, sub, path, claimToken,
    extra: { reviewers: reviewerDoor(reviewers, { request, hosted, owner }), mail: network.mail, fixtures: network.fixtures } });
  } catch {
   return finish({ ok: false, points: [...validation.points, ...reviewers.points(), { id: 'BASE-AGENT-001.owner-bootstrap', ok: false, detail: 'Native owner bootstrap did not complete through the hosted installation origin.' }] }, report);
  }
  const { cookie, failure } = await ownerSession(bootstrap);
  if (failure) return finish({ ok: false, points: [...validation.points, { id: 'BASE-AGENT-001.owner-bootstrap', ok: false, detail: failure }] }, report);
  const iat = seconds();
  const settings = await signJws(pair.privateKey, kid, 'rer-business-settings+jwt', {
   v: 1, iss: issuer, aud: hosted.origin, sub: installationId, business, email, owner_id: sub,
   jti: randomUUID(), iat, exp: iat + 300, rev: 1, values: {}, logo: null, team: principals.length > 1 ? principals.slice(1).map(person => ({ id: person.sub, email: person.email, name: person.label, role: person.role, invite: 1 })) : null,
  });
  const paired = await request(new URL('/api/rer/business-settings', hosted.origin).href, {
   method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }),
  });
  let ack; try { ack = await paired.json(); } catch {}
  if (!paired.ok || ack?.rev !== 1) return finish({ ok: false, points: [...validation.points, { id: 'BASE-AGENT-004.business-owner-binding', ok: false, detail: `Signed Business owner binding returned HTTP ${paired.status} without the expected acknowledgement.` }] }, report);
  const sponsors = [{ email, cookie, sub, label: native.label }];
  for (const principal of principals.slice(1)) {
   const issued = seconds();
   const signedClaim = await signJws(pair.privateKey, kid, 'rer-owner-claim+jwt', {
    v: 1, iss: issuer, aud: hosted.origin, installationId, email: principal.email, jti: randomUUID(), iat: issued, exp: issued + 300,
   });
   let response;
   try {
    response = await principal.initialize({ request, origin: hosted.origin, email: principal.email, sub: principal.sub,
     label: principal.label, displayName: principal.label, token, claim: { mode: 'signed', path, token: signedClaim },
     owner: sponsors[0], database: hosted.database, mail: network.mailFor(principal.email), fixtures: network.fixtures, returnTo: owner?.returnTo ?? '/',
    });
   } catch { throw new RerError('agent_sponsor_bootstrap', 'An additional sponsor could not complete its native lifecycle through the disposable installation.', 1); }
   const session = response?.headers?.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
   await response?.body?.cancel();
   if (response?.status !== 303 || response.redirected || !session) throw new RerError('agent_sponsor_bootstrap', 'Each sponsor initializer must return its native final 303 session response.', 1);
   sponsors.push({ email: principal.email, cookie: session, sub: principal.sub, label: principal.label });
  }
  const secrets = await network.provision(hosted);
  const webhooks = await verificationWebhooks(root, verification.webhooks, secrets);
  history = await verificationHistory(root, verification.history);
  const journey = await verificationJourney(root, verification.journey, { request, origin: hosted.origin, email, cookie, mail: network.mail, fixtures: network.fixtures, ...await hosted.preparation() });
  const prepare = await journeyFixtures(root, verification.fixtures, { request, origin: hosted.origin, email, cookie, mail: network.mail, fixtures: network.fixtures, ...await hosted.preparation() });
  const nativeStep = history ? async value => {
   await history.run(value, (declaration, rows) => writeVerificationHistory(hosted, declaration, rows));
   await journey.nativeStep?.(value);
  } : journey.nativeStep;
  const result = await runAgentDoorConformance({ fetch: request, origin: hosted.origin, surface: declared.surface,
   signer: { issuer, installationId, kid, privateKey: pair.privateKey }, person: sponsors[0], sponsors: sponsors.filter(person => !negativeOnly.has(person.label)), webhooks, business, prove, ...journey, nativeStep, prepare, invoke: workerDriver?.run(hosted),
   initializeAgent: initializeAgent && (({ agentId, person }) => initializeAgent({ agentId, person, request, origin: hosted.origin, mail: network.mail, fixtures: network.fixtures })),
   unpair: () => hosted.rebind(pairedBindings),
  });
  const points = [...result.points, ...reviewers.points()];
  return finish({ ...result, points, ok: points.every(point => point.ok) }, report);
 } finally {
  try { await history?.close(); }
  finally { reviewers.close(); try { await hosted?.close(); } finally { await network.close(); } }
 }
}

if (process.argv[1] && await realpath(new URL(import.meta.url)) === await realpath(process.argv[1])) {
 try { await checkAgentDoor(resolve(process.argv[2] ?? '.'), { declaration: process.argv[3] }); }
 catch (error) { console.error(error instanceof RerError ? error.message : 'Agent door conformance could not complete.'); process.exitCode = 1; }
}
