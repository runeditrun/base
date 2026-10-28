import { ARITHMETIC } from '../arithmetic.ts';

const ref = subject => [subject.kind, subject.id];
const predicate = (sql, bindings) => ({ sql, bindings });
function conjunction(guards) {
  return predicate(guards.map(guard => `(${guard.sql})`).join(' AND '), guards.flatMap(guard => guard.bindings));
}
function subjectGuard(installation, row) {
  return predicate('EXISTS(SELECT 1 FROM native_subjects WHERE installation=? AND kind=? AND id=? AND revision=? AND terms_revision=?)', [installation, row.kind, row.id, row.revision, row.terms_revision]);
}
function offerGuard(installation, row) {
  return predicate('EXISTS(SELECT 1 FROM native_offers WHERE installation=? AND id=? AND revision=? AND item_revision=? AND subject_kind=? AND subject_id=? AND active=1)', [installation, row.id, row.revision, row.item_revision, row.subject_kind, row.subject_id]);
}
function offer(row, subject) {
  return { item: { source: row.item_source, id: row.item_id, revision: row.item_revision }, offerId: row.id,
    revision: String(row.revision), description: row.description, unit: row.unit,
    price: row.price_coefficient === null ? null : { coefficient: row.price_coefficient, scale: row.price_scale },
    currency: row.currency, currencyExponent: row.currency_exponent, audience: subject, termsRevision: String(row.terms_revision) };
}

/** Native test adopter: real database records, native IDs and same-database guards. */
export function nativeOptions(db, session) {
  const installation = session.installation;
  async function nativeSubject(subject) {
    const row = await db.prepare('SELECT * FROM native_subjects WHERE installation=? AND kind=? AND id=?').bind(installation, ...ref(subject)).first();
    if (!row) throw new Error('The native subject is unavailable');
    return row;
  }
  return {
    db,
    authority: {
      async authorize(context, action, subject) {
        const row = await db.prepare(`SELECT p.revision AS person_revision,m.revision AS membership_revision,m.fields
          FROM native_people p JOIN native_memberships m ON m.installation=p.installation AND m.person_id=p.id
          JOIN native_subjects n ON n.installation=m.installation AND n.kind=m.subject_kind AND n.id=m.subject_id
          WHERE p.installation=? AND p.id=? AND p.active=1 AND m.active=1 AND m.subject_kind=? AND m.subject_id=?`).bind(installation, context.actor.personId, ...ref(subject)).first();
        if (!row) return null;
        const guard = predicate(`EXISTS(SELECT 1 FROM native_people p
          JOIN native_memberships m ON m.installation=p.installation AND m.person_id=p.id
          JOIN native_sessions s ON s.installation=p.installation AND s.person_id=p.id
          WHERE p.installation=? AND p.id=? AND p.active=1 AND p.revision=?
          AND m.subject_kind=? AND m.subject_id=? AND m.active=1 AND m.revision=?
          AND s.token=? AND s.active=1 AND s.revision=?)`, [installation, context.actor.personId, row.person_revision, ...ref(subject), row.membership_revision, session.token, session.revision]);
        return { revision: `${row.person_revision}:${row.membership_revision}`, fields: row.fields, guard };
      },
    },
    offers: {
      async list(context, subject, page) {
        const native = await nativeSubject(subject);
        const rows = (await db.prepare(`SELECT o.*,s.terms_revision FROM native_offers o
          JOIN native_subjects s ON s.installation=o.installation AND s.kind=o.subject_kind AND s.id=o.subject_id
          WHERE o.installation=? AND o.subject_kind=? AND o.subject_id=? AND o.active=1 AND o.id>?
          ORDER BY o.id LIMIT ?`).bind(installation, ...ref(subject), page.cursor ?? '', page.limit + 1).all()).results;
        const visible = rows.slice(0, page.limit);
        return { offers: visible.map(row => offer(row, subject)), next: rows.length > page.limit ? visible.at(-1).id : null,
          guard: conjunction([subjectGuard(installation, native), ...visible.map(row => offerGuard(installation, row))]) };
      },
      async load(context, subject, selection) {
        const native = await nativeSubject(subject);
        const rows = (await Promise.all(selection.map(line => db.prepare(`SELECT o.*,s.terms_revision FROM native_offers o
          JOIN native_subjects s ON s.installation=o.installation AND s.kind=o.subject_kind AND s.id=o.subject_id
          WHERE o.installation=? AND o.subject_kind=? AND o.subject_id=? AND o.id=? AND o.item_source=?
          AND o.item_id=? AND o.item_revision=? AND o.active=1`).bind(installation, ...ref(subject), line.offerId, line.item.source, line.item.id, line.item.revision).first()))).filter(Boolean);
        return { offers: rows.map(row => offer(row, subject)), guard: conjunction([subjectGuard(installation, native), ...rows.map(row => offerGuard(installation, row))]) };
      },
    },
    pricing: {
      async resolve(context, subject, lines) {
        const native = await nativeSubject(subject);
        const rows = await Promise.all(lines.map(line => db.prepare('SELECT * FROM native_offers WHERE installation=? AND id=?').bind(installation, line.offer.offerId).first()));
        return {
          lines: lines.map((line, index) => {
            const row = rows[index];
            return { id: line.selection.id, price: { coefficient: row.price_coefficient, scale: row.price_scale },
              conversion: { numerator: row.numerator, denominator: row.denominator }, arithmetic: ARITHMETIC[row.profile], calculation: { basis: 'exact' },
              breakdown: [
                { kind: row.price_coefficient.startsWith('-') ? 'discount' : 'price', amount: { coefficient: row.price_coefficient, scale: row.price_scale }, source: line.offer.item, visibility: 'commercial' },
                { kind: 'cost', amount: { coefficient: '1713', scale: 2 }, source: line.offer.item, visibility: 'cost' },
              ] };
          }),
          terms: { revision: String(native.terms_revision), description: native.description,
            counterparty: subject, delivery: native.delivery, payment: native.payment,
            facts: { configuration: native.configuration, subjectRevision: String(native.revision), subjectState: native.state } },
          guard: conjunction([subjectGuard(installation, native), ...rows.map(row => offerGuard(installation, row))]),
        };
      },
    },
    native: {
      async prepareCommit(context, { snapshot, operation, key }) {
        // No reads or network I/O: all authority comes from the reviewed native
        // facts and each write checks the exact native state in this transaction.
        const orderId = `native-order:${snapshot.id}`;
        const guard = predicate(`EXISTS(SELECT 1 FROM native_subjects s JOIN native_command_controls c ON c.installation=s.installation
          WHERE s.installation=? AND s.kind=? AND s.id=? AND s.revision=? AND s.terms_revision=? AND s.state=? AND c.allowed=1)`,
          [installation, ...ref(snapshot.subject), Number(snapshot.terms.facts.subjectRevision), Number(snapshot.terms.revision), snapshot.terms.facts.subjectState]);
        const statement = (sql, bindings) => ({ sql: `${sql} WHERE (${guard.sql})`, bindings: [...bindings, ...guard.bindings] });
        const statements = [
          statement('INSERT INTO native_orders(installation,id,snapshot_id,subject_kind,subject_id,person_id,revision,status,payload) SELECT ?,?,?,?,?,?,1,?,?', [installation, orderId, snapshot.id, ...ref(snapshot.subject), context.actor.personId, 'placed', JSON.stringify(snapshot)]),
          statement('INSERT INTO native_command_outcomes(installation,id,snapshot_id,order_id,operation,operation_key,person_id) SELECT ?,?,?,?,?,?,?', [installation, `outcome:${snapshot.id}`, snapshot.id, orderId, operation, key, context.actor.personId]),
          statement('INSERT INTO native_audit(installation,id,snapshot_id,actor,action,fingerprint) SELECT ?,?,?,?,?,?', [installation, `audit:${snapshot.id}`, snapshot.id, JSON.stringify(context.actor), operation, snapshot.fingerprint]),
          statement('INSERT INTO native_payment_intents(installation,id,snapshot_id,order_id,state,currency,coefficient,scale) SELECT ?,?,?,?,?,?,?,?', [installation, `intent:${snapshot.id}`, snapshot.id, orderId, 'pending', snapshot.currency, snapshot.total.coefficient, snapshot.total.scale]),
        ];
        return { guard, statements, outcome: { kind: 'native-order', id: orderId, revision: '1' },
          postcondition: predicate(`EXISTS(SELECT 1 FROM native_orders o
            JOIN native_command_outcomes c ON c.installation=o.installation AND c.order_id=o.id
            JOIN native_audit a ON a.installation=o.installation AND a.snapshot_id=o.snapshot_id
            JOIN native_payment_intents p ON p.installation=o.installation AND p.order_id=o.id
            WHERE o.installation=? AND o.id=? AND o.snapshot_id=? AND c.operation=? AND c.operation_key=?
            AND o.person_id=? AND a.fingerprint=? AND p.state='pending')`, [installation, orderId, snapshot.id, operation, key, context.actor.personId, snapshot.fingerprint]) };
      },
    },
  };
}
