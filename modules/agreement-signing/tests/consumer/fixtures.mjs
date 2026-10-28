import { createHash, randomUUID } from 'node:crypto';

const encode = value => new TextEncoder().encode(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const reference = (id, mediaType, bytes) => ({ id, version: '1', mediaType, sha256: digest(bytes), size: bytes.length });

function pdf(text) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => { const start = result.length; result += `${index + 1} 0 obj\n${body}\nendobj\n`; return start; });
  const xref = result.length;
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(result);
}

export async function seedNative(db, { profile, expiresInMs, legacy = true }) {
  if (!['text-terms', 'pdf-html-signature'].includes(profile)) throw new TypeError(`Unsupported signing fixture profile: ${profile}`);
  const terms = profile === 'text-terms';
  const objects = terms
    ? [{ bytes: encode('Offer A: 3 services at 41.50 AUD each; total AUD 124.50. Accept these exact terms.'), mediaType: 'text/plain' }]
    : [{ bytes: pdf('Offer A: total AUD 124.50. Exact approved PDF.'), mediaType: 'application/pdf' },
      { bytes: encode('<!doctype html><title>Offer selection</title><p>3 services. Total AUD 124.50.</p>'), mediaType: 'text/html' }];
  const documentRefs = objects.map((object, index) => reference(`offer-main/document-${index}`, object.mediaType, object.bytes));
  const purposes = terms ? ['accept-terms'] : ['electronic-records', 'signature-intent'];
  const consentObjects = purposes.map(purpose => ({ bytes: encode(purpose === 'accept-terms'
    ? 'I accept these exact offered terms.' : purpose === 'electronic-records'
      ? 'I consent to receive and retain these records electronically.' : 'I intend this typed name to be my signature on this exact offer.'), mediaType: 'text/plain' }));
  const consentRefs = consentObjects.map((object, index) => reference(`offer-main/consent-${index}`, object.mediaType, object.bytes));
  const providerObject = { bytes: encode('Provider-original execution returned for a different selected option. Preserve pending mismatch review.'), mediaType: 'text/plain' };
  const externalArtifact = reference('offer-main/provider-original', providerObject.mediaType, providerObject.bytes);
  const approvedFields = { option: 'offer-a', quantity: 3, totalMinor: 12450 };
  const participants = ['alice', 'bob', 'hr'].map((actor, index) => ({ actor, recipientId: `recipient-${index}` }));
  const definition = { source: { kind: 'native-offer', id: 'offer-main', revision: '1' }, kind: terms ? 'terms-acceptance' : 'electronic-signature',
    documents: documentRefs, recipients: participants.map((participant, index) => ({ id: participant.recipientId, subjectId: `person-${participant.actor}`,
      action: terms ? 'accept' : 'sign', order: index === 2 ? 1 : 0,
      documentIds: terms || index === 2 ? documentRefs.map(item => item.id) : [documentRefs[index].id], authentication: 'native-session' })),
    approvalDigest: digest(JSON.stringify(documentRefs)), selectionDigest: digest(JSON.stringify(approvedFields)),
    expiresAt: expiresInMs ? new Date(Date.now() + expiresInMs).toISOString() : null,
    consents: purposes.map((purpose, index) => ({ purpose, wording: consentRefs[index], language: 'en-AU' })),
    completion: 'artifacts-required', closures: ['withdrawn', 'cancelled'], replaces: null };
  await db.prepare('INSERT INTO native_sources VALUES (?,?,?,?,?,?,?)').bind('offer-main', 1, JSON.stringify(definition), 12450, 'AUD', 'approved', JSON.stringify(approvedFields)).run();
  const allObjects = [...objects, ...consentObjects, providerObject];
  for (const [index, ref] of [...documentRefs, ...consentRefs, externalArtifact].entries()) {
    await db.prepare('INSERT INTO native_objects VALUES (?,?,?,?,?)').bind(ref.id, ref.version, JSON.stringify(ref), allObjects[index].bytes, 'offer-main').run();
  }
  for (const participant of definition.recipients) await db.prepare('INSERT INTO native_participants VALUES (?,?,?)').bind('offer-main', participant.id, participant.subjectId).run();
  const identities = {};
  for (const actor of ['owner', 'alice', 'bob', 'hr', 'outsider', 'agent']) {
    const token = randomUUID();
    const actorId = actor === 'agent' ? 'agent-assistant' : `person-${actor}`;
    identities[actor] = { cookie: `native_session=${token}`, actorId };
    await db.prepare('INSERT INTO native_sessions VALUES (?,?,?,?,?,?,1)').bind(token, actorId, actor === 'agent' ? 'person-alice' : actorId,
      'native-session', actor === 'agent' ? actorId : null, actor === 'agent' ? 'person-alice' : null).run();
    if (actor !== 'outsider') await db.prepare('INSERT INTO native_access VALUES (?,?,?)').bind(actorId, 'offer-main', actor === 'owner' || actor === 'agent' ? 1 : 0).run();
  }
  const fixture = { sourceId: 'offer-main', definition, participants, externalArtifact,
    sessionSecrets: Object.values(identities).map(identity => identity.cookie.split('=')[1]),
    binding: { documentIds: documentRefs.map(item => item.id), approvalDigest: definition.approvalDigest, selectionDigest: definition.selectionDigest,
      fields: approvedFields, act: terms ? { type: 'accept', statement: 'I accept the offered terms.' } : { type: 'typed-signature', name: 'Alex Participant' },
      consents: definition.consents } };
  if (legacy) {
    const originalBytes = encode('Historically accepted café agreement\r\n3 × 39.00 AUD = 117.00 AUD\r\nOriginal native receipt.\r\n');
    const artifact = reference('offer-legacy/signed', 'text/plain', originalBytes);
    const auditRoot = digest('native audit chain ending at the original accepted agreement');
    const approvedSelection = { optionId: 'historic-option', quantity: 3, unitMinor: 3900, totalMinor: 11700 };
    await db.prepare('INSERT INTO native_sources VALUES (?,?,?,?,?,?,?)').bind('offer-legacy', 4, '{}', 11700, 'AUD', 'completed', JSON.stringify(approvedSelection)).run();
    await db.prepare('INSERT INTO native_access VALUES (?,?,?)').bind(identities.owner.actorId, 'offer-legacy', 1).run();
    await db.prepare('INSERT INTO native_objects VALUES (?,?,?,?,?)').bind(artifact.id, artifact.version, JSON.stringify(artifact), originalBytes, 'offer-legacy').run();
    await db.prepare('INSERT INTO native_legacy_agreements VALUES (?,?,?,?,?,?,?,?,?)').bind('legacy-agreement-73', 'offer-legacy', '4', 11700, 'AUD',
      JSON.stringify(approvedSelection), auditRoot, JSON.stringify(artifact), '2025-08-11T01:30:00.000Z').run();
    fixture.legacyBefore = { id: 'legacy-agreement-73', source: { kind: 'native-offer', id: 'offer-legacy', revision: '4' },
      historical: { amountMinor: 11700, currency: 'AUD', approvedSelection }, auditRoot, artifact, base64: Buffer.from(originalBytes).toString('base64'),
      native: (await db.prepare('SELECT * FROM native_legacy_agreements ORDER BY id').all()).results };
  }
  return { fixture, identities };
}
