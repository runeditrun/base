import { createHash } from 'node:crypto';

export const INSTALLATION = 'native-catalogue-test-installation';
export const actors = Object.freeze({ buyer: 'test-session-buyer-9a718605', peer: 'test-session-peer-81e1758a', outsider: 'test-session-outsider-3f8b0ad9' });
export const people = Object.freeze({ [actors.buyer]: 'native-person-buyer', [actors.peer]: 'native-person-peer', [actors.outsider]: 'native-person-outsider' });
export const LEGACY_ORIGINAL = '{\n  "id": "legacy-order-0007", "amount": "000000012.3400500",\n  "approved": "2019-04-03", "note": "Original spacing / café"\n}\n';
const decimal = (coefficient, scale) => ({ coefficient, scale });
const primary = { kind: 'account', id: 'account-exact' };
const other = { kind: 'account', id: 'account-other' };
const examples = [
  { profile: 'EXACT_TWELVE', arithmeticId: 'exact-twelve', subject: primary, price: decimal('123456', 6), quantity: decimal('1000001', 6), extension: decimal('123456123456', 12) },
  { profile: 'CENTS_MILLIONTH', arithmeticId: 'cents-millionth', subject: { kind: 'manufacturing-quote', id: 'manufacturing-cents' }, price: decimal('1', 2), quantity: decimal('500000', 6), extension: decimal('1', 2) },
  { profile: 'SIX_PLACE', arithmeticId: 'six-place', subject: { kind: 'manufacturing-quote', id: 'manufacturing-six' }, price: decimal('500000', 6), quantity: decimal('1', 6), extension: decimal('1', 6) },
  { profile: 'RATIONAL_EIGHTEEN', arithmeticId: 'rational-eighteen', subject: { kind: 'manufacturing-quote', id: 'manufacturing-rational' }, price: decimal('15', 2), quantity: decimal('100000000000000001', 18), extension: decimal('1', 2), conversion: { numerator: '1', denominator: '3' }, baseQuantity: null, baseQuantityRatio: { numerator: '100000000000000001', denominator: '3000000000000000000' } },
  { profile: 'CENTS_THOUSANDTH', arithmeticId: 'cents-thousandth', subject: { kind: 'account', id: 'account-discount' }, price: decimal('-1', 2), quantity: decimal('500', 3), extension: decimal('-1', 2) },
  { profile: 'CENTS_WHOLE', arithmeticId: 'cents-whole', subject: { kind: 'account', id: 'account-whole' }, price: decimal('1', 2), quantity: decimal('2', 0), extension: decimal('2', 2) },
];
function selection(subject, id, quantity = decimal('1', 0)) {
  return { subject, lines: [{ id: 'native-line-1', item: { source: 'native-catalogue', id: `item-${id}`, revision: '1' }, offerId: id, quantity }] };
}
export const fixture = Object.freeze({
  actors,
  selection: selection(primary, 'offer-EXACT_TWELVE', examples[0].quantity),
  foreignSelection: selection(primary, 'offer-other'),
  missingSelection: selection(primary, 'offer-missing'),
  unpricedSelection: selection(primary, 'offer-unpriced'),
  profiles: examples.map(example => ({ ...example, selection: selection(example.subject, `offer-${example.profile}`, example.quantity), total: example.extension })),
  history: { id: 'legacy-order-0007', original: LEGACY_ORIGINAL, source: { source: 'native-orders', id: 'legacy-order-0007', revision: 'original-v2' } },
  forbiddenExportStrings: Object.values(actors),
});
export const supportedProfiles = examples.map(example => example.profile);

export async function seedNative(db) {
  const statements = [];
  for (const [token, personId] of Object.entries(people)) {
    statements.push(db.prepare('INSERT INTO native_people VALUES(?,?,1,1)').bind(INSTALLATION, personId));
    statements.push(db.prepare('INSERT INTO native_sessions VALUES(?,?,?,1,1)').bind(token, INSTALLATION, personId));
  }
  const subjects = [...examples.map(example => example.subject), other];
  for (const subject of subjects) {
    statements.push(db.prepare('INSERT INTO native_subjects VALUES(?,?,?,1,1,?,?,?,?,?)').bind(INSTALLATION, subject.kind, subject.id, `Native ${subject.id}`, 'Dock 7 / original address', 'Net 30', 'configuration-original', 'ready'));
    const members = subject.id === other.id ? [actors.outsider] : [actors.buyer, actors.peer];
    for (const token of members) statements.push(db.prepare('INSERT INTO native_memberships VALUES(?,?,?,?,1,1,?)').bind(INSTALLATION, people[token], subject.kind, subject.id, 'commercial'));
  }
  const offers = [...examples.map(example => ({ ...example, id: `offer-${example.profile}` })),
    { ...examples[0], subject: primary, id: 'offer-unpriced', price: null },
    { ...examples[0], subject: other, id: 'offer-other' }];
  for (const offer of offers) {
    const conversion = offer.conversion ?? { numerator: '1', denominator: '1' };
    statements.push(db.prepare('INSERT INTO native_offers VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,1)').bind(INSTALLATION, offer.subject.kind, offer.subject.id, offer.id, 'native-catalogue', `item-${offer.id}`, '1', `Original ${offer.id}`, 'each', offer.price?.coefficient ?? null, offer.price?.scale ?? 6, 'USD', 2, offer.profile, conversion.numerator, conversion.denominator));
  }
  statements.push(db.prepare('INSERT INTO native_command_controls VALUES(?,1)').bind(INSTALLATION));
  statements.push(db.prepare('INSERT INTO native_orders VALUES(?,?,NULL,?,?,?,2,?,?)').bind(INSTALLATION, fixture.history.id, primary.kind, primary.id, 'retired-native-person', 'historical', LEGACY_ORIGINAL));
  statements.push(db.prepare('INSERT INTO native_order_history VALUES(?,?,?,?,NULL,NULL,?)').bind(INSTALLATION, fixture.history.id, fixture.history.source.revision, LEGACY_ORIGINAL, createHash('sha256').update(LEGACY_ORIGINAL).digest('hex')));
  await db.batch(statements);
}
