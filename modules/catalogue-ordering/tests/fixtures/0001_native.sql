-- Test adopter's native schema. There is intentionally no stock ledger.
CREATE TABLE native_people (
 installation TEXT NOT NULL, id TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY(installation,id)
);
CREATE TABLE native_sessions (
 token TEXT PRIMARY KEY, installation TEXT NOT NULL, person_id TEXT NOT NULL,
 active INTEGER NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE native_memberships (
 installation TEXT NOT NULL, person_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 active INTEGER NOT NULL, revision INTEGER NOT NULL, fields TEXT NOT NULL,
 PRIMARY KEY(installation,person_id,subject_kind,subject_id)
);
CREATE TABLE native_subjects (
 installation TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
 terms_revision INTEGER NOT NULL, description TEXT NOT NULL, delivery TEXT NOT NULL,
 payment TEXT NOT NULL, configuration TEXT NOT NULL, state TEXT NOT NULL,
 PRIMARY KEY(installation,kind,id)
);
CREATE TABLE native_offers (
 installation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 id TEXT NOT NULL, revision INTEGER NOT NULL, item_source TEXT NOT NULL, item_id TEXT NOT NULL,
 item_revision TEXT NOT NULL, description TEXT NOT NULL, unit TEXT NOT NULL,
 price_coefficient TEXT, price_scale INTEGER NOT NULL, currency TEXT NOT NULL,
 currency_exponent INTEGER NOT NULL, profile TEXT NOT NULL, numerator TEXT NOT NULL,
 denominator TEXT NOT NULL, active INTEGER NOT NULL,
 PRIMARY KEY(installation,id)
);
CREATE TABLE native_command_controls (installation TEXT PRIMARY KEY, allowed INTEGER NOT NULL);
CREATE TABLE native_orders (
 installation TEXT NOT NULL, id TEXT NOT NULL, snapshot_id TEXT, subject_kind TEXT NOT NULL,
 subject_id TEXT NOT NULL, person_id TEXT NOT NULL, revision INTEGER NOT NULL,
 status TEXT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(installation,id), UNIQUE(installation,snapshot_id)
);
CREATE TABLE native_order_history (
 installation TEXT NOT NULL, order_id TEXT NOT NULL, revision TEXT NOT NULL,
 original TEXT NOT NULL, currency TEXT, arithmetic TEXT, fingerprint TEXT NOT NULL,
 PRIMARY KEY(installation,order_id,revision)
);
CREATE TABLE native_command_outcomes (
 installation TEXT NOT NULL, id TEXT NOT NULL, snapshot_id TEXT NOT NULL, order_id TEXT NOT NULL,
 operation TEXT NOT NULL, operation_key TEXT NOT NULL, person_id TEXT NOT NULL,
 PRIMARY KEY(installation,id), UNIQUE(installation,snapshot_id)
);
CREATE TABLE native_audit (
 installation TEXT NOT NULL, id TEXT NOT NULL, snapshot_id TEXT NOT NULL, actor TEXT NOT NULL,
 action TEXT NOT NULL, fingerprint TEXT NOT NULL,
 PRIMARY KEY(installation,id), UNIQUE(installation,snapshot_id)
);
CREATE TABLE native_payment_intents (
 installation TEXT NOT NULL, id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 order_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state='pending'),
 currency TEXT NOT NULL, coefficient TEXT NOT NULL, scale INTEGER NOT NULL,
 PRIMARY KEY(installation,id), UNIQUE(installation,snapshot_id)
);
