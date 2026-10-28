CREATE TABLE native_sources (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition TEXT NOT NULL,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, state TEXT NOT NULL, approved_fields TEXT NOT NULL
);
CREATE TABLE native_sessions (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  authentication TEXT NOT NULL, agent_id TEXT, sponsor_id TEXT, active INTEGER NOT NULL
);
CREATE TABLE native_access (actor_id TEXT NOT NULL, source_id TEXT NOT NULL, can_manage INTEGER NOT NULL,
  PRIMARY KEY (actor_id, source_id));
CREATE TABLE native_participants (source_id TEXT NOT NULL, recipient_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  PRIMARY KEY (source_id, recipient_id));
CREATE TABLE native_objects (id TEXT NOT NULL, version TEXT NOT NULL, reference TEXT NOT NULL, bytes BLOB NOT NULL,
  source_id TEXT NOT NULL, PRIMARY KEY (id, version));
CREATE TRIGGER native_objects_immutable_update BEFORE UPDATE ON native_objects BEGIN SELECT RAISE(ABORT, 'immutable object'); END;
CREATE TRIGGER native_objects_immutable_delete BEFORE DELETE ON native_objects BEGIN SELECT RAISE(ABORT, 'immutable object'); END;
CREATE TABLE native_signing_actions (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, source_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE native_completed_agreements (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE native_legacy_agreements (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_revision TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL, approved_selection TEXT NOT NULL, audit_root TEXT, artifact TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE native_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO native_settings VALUES ('artifact-write-failure', 'false');
