import { bytes, check, equal, success, refused, command, evidence, current, issue, review, sign, redemption, withRuntime } from './helpers.mjs';

export async function custodyUpgradeRestore(adapter, profile, runtime) {
  const baseline = runtime.fixture.legacyBefore;
  check(baseline, 'Populated upgrade evidence is mandatory; an empty migration is not conformance');
  const legacy = await evidence(runtime, baseline.id);
  equal(legacy.request.recordKind, 'legacy', 'Unknown historical assurance stays a legacy record');
  equal(legacy.request.originalId, baseline.id, 'Upgrade preserves the historical native ID');
  equal(legacy.request.source, baseline.source, 'Upgrade preserves native source ties');
  equal(legacy.request.historical, baseline.historical, 'Upgrade retains arithmetic and original native facts');
  equal(legacy.request.originalAuditRoot, baseline.auditRoot, 'Original audit lineage survives adoption');
  equal(legacy.request.authentication, null, 'Unknown old authentication remains unknown');
  equal(legacy.request.consent, null, 'Unknown old consent remains unknown');
  equal(legacy.actions.length, 0, 'Migration invents no native signature event');
  const upgradedNative = await success(runtime.nativeState());
  equal(upgradedNative.legacy, baseline.native, 'Native populated history survives the forward migration');
  const originalDownload = await runtime.download(baseline.artifact);
  equal(originalDownload.status, 200, 'Historical download retains authorized access');
  equal([...new Uint8Array(await originalDownload.arrayBuffer())], [...bytes(baseline.base64)], 'Historical exact signed bytes survive upgrade');
  await refused(runtime.evidence(baseline.id, 'outsider'));

  const issued = await issue(runtime);
  const execution = await success(command(runtime, 'recordExternal', { request: { id: issued.request.id, revision: issued.request.revision },
    provider: 'native-provider-adapter', providerRequestId: 'returned-provider-packet',
    provenance: { source: 'provider-original-download', receivedAt: new Date().toISOString(), attribution: 'native-owner' },
    disposition: 'mismatch-pending', artifacts: [runtime.fixture.externalArtifact] }));
  const externalHistory = await evidence(runtime, issued.request.id);
  equal(externalHistory.executions[0], execution, 'Provider-original provenance and mismatch disposition remain distinct evidence');
  equal(externalHistory.actions.length, 0, 'Provider execution never invents a native personal act');
  equal(externalHistory.request.state, 'issued', 'Unresolved provider mismatch does not complete a native request');
  await sign(runtime, issued, 0);
  await sign(runtime, issued, 1);
  const finalReview = await success((await review(runtime, issued, 2)).result);
  await runtime.failArtifactPut(true);
  const attempted = await command(runtime, 'sign', redemption(issued, finalReview), runtime.fixture.participants[2].actor, 'complete-with-custody');
  check(attempted.status >= 400, 'Custody write failure must not report completion');
  check((await current(runtime, issued.request.id)).state !== 'completed', 'Missing final bytes cannot produce completed state');
  equal((await success(runtime.nativeState())).completions.length, 0, 'Failed custody leaves no native completion');
  await runtime.failArtifactPut(false);
  const completed = await success(command(runtime, 'sign', redemption(issued, finalReview), runtime.fixture.participants[2].actor, 'complete-with-custody'));
  equal(completed.request.state, 'completed', 'The same command can complete after real custody recovers');
  const bundle = await evidence(runtime, issued.request.id);
  equal((await success(command(runtime, 'verify', { bundle }))).valid, true, 'Exported bytes and complete lineage verify');
  check(bundle.artifacts.length >= runtime.fixture.definition.documents.length, 'Export includes the referenced original and completed bytes');
  for (const artifact of bundle.artifacts) {
    const response = await runtime.download(artifact.reference);
    equal(response.status, 200, 'Authorized artifact download remains available');
    equal([...new Uint8Array(await response.arrayBuffer())], [...bytes(artifact.base64)], 'Evidence export and public download have identical bytes');
  }
  const exported = JSON.stringify(bundle);
  for (const secret of [...issued.invitations.map(item => item.token), finalReview.token, ...runtime.fixture.sessionSecrets]) check(!exported.includes(secret), 'Portable evidence must exclude usable session/invitation/review authority');
  const corrupt = structuredClone(bundle);
  corrupt.artifacts[0].base64 = btoa('Altered immutable bytes');
  equal((await success(command(runtime, 'verify', { bundle: corrupt }))).valid, false, 'Modified artifact bytes fail verification');
  const missing = structuredClone(bundle);
  missing.artifacts.shift();
  equal((await success(command(runtime, 'verify', { bundle: missing }))).valid, false, 'Missing referenced bytes fail verification');
  const altered = structuredClone(bundle);
  altered.events[0].payload.actorId = 'different-native-person';
  equal((await success(command(runtime, 'verify', { bundle: altered }))).valid, false, 'Modified audit lineage fails verification');
  await refused(runtime.evidence(issued.request.id, 'outsider'));

  await withRuntime(adapter, profile, async target => {
    const restored = await success(command(target, 'restore', { bundle }));
    check(restored.restored, 'Restore marks historical authority inert');
    equal(restored.id, bundle.request.id, 'Restore preserves request identity');
    const restoredBundle = await evidence(target, restored.id);
    equal(restoredBundle.actions, bundle.actions, 'Restore preserves personal evidence');
    equal(restoredBundle.executions, bundle.executions, 'Restore preserves provider history without calling a provider');
    equal(restoredBundle.artifacts, bundle.artifacts, 'Restore preserves every referenced byte');
    equal((await success(target.nativeState())).completions.length, 0, 'Restore does not replay native business effects');
    await refused(command(target, 'issue', { id: restored.id, revision: restored.revision }), ['restored_inert']);
    await refused(command(target, 'sign', redemption(issued, finalReview), target.fixture.participants[2].actor), ['restored_inert']);
    await refused(command(target, 'recordExternal', { request: { id: restored.id, revision: restored.revision }, provider: 'provider-history', providerRequestId: 'historical-provider-request',
      provenance: { source: 'provider-export', receivedAt: new Date().toISOString(), attribution: 'native-owner' }, disposition: 'matched', artifacts: bundle.request.definition.documents }), ['restored_inert']);
    await refused(target.evidence(restored.id, 'outsider'));
    await target.revoke('owner');
    await refused(target.evidence(restored.id));
  }, { legacy: false });

  await runtime.revoke('owner');
  await refused(runtime.evidence(issued.request.id));
}
