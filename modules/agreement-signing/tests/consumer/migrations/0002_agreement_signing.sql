-- Fresh schema only. Copy into the NEXT unused native numbered migration.
PRAGMA foreign_keys = ON;
CREATE TABLE as_requests (
  id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('native','legacy')),
  definition TEXT CHECK(definition IS NULL OR json_valid(definition)),
  legacy TEXT CHECK(legacy IS NULL OR json_valid(legacy)),
  state TEXT NOT NULL CHECK(state IN ('draft','issued','in-progress','completed','declined','cancelled','expired','withdrawn')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  restored INTEGER NOT NULL DEFAULT 0 CHECK(restored IN (0,1)),
  root TEXT,
  completed_artifacts TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(completed_artifacts)),
  CHECK((record_kind='native' AND definition IS NOT NULL AND legacy IS NULL) OR
        (record_kind='legacy' AND definition IS NULL AND legacy IS NOT NULL))
);
CREATE TABLE as_source_map (
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES as_requests(id),
  PRIMARY KEY(source_kind,source_id,source_revision)
);
CREATE TABLE as_documents (
  request_id TEXT NOT NULL REFERENCES as_requests(id), document_id TEXT NOT NULL,
  reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
  PRIMARY KEY(request_id,document_id)
);
CREATE TABLE as_recipients (
  request_id TEXT NOT NULL REFERENCES as_requests(id), recipient_id TEXT NOT NULL,
  subject_id TEXT NOT NULL, participant TEXT NOT NULL CHECK(json_valid(participant)),
  PRIMARY KEY(request_id,recipient_id)
);
CREATE TABLE as_credentials (
  digest TEXT PRIMARY KEY, request_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  FOREIGN KEY(request_id,recipient_id) REFERENCES as_recipients(request_id,recipient_id)
);
CREATE TABLE as_reviews (
  digest TEXT PRIMARY KEY, request_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, subject_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  authentication TEXT NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  signable_digest TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
  FOREIGN KEY(request_id,recipient_id) REFERENCES as_recipients(request_id,recipient_id)
);
CREATE TABLE as_actions (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  UNIQUE(request_id,recipient_id),
  FOREIGN KEY(request_id,recipient_id) REFERENCES as_recipients(request_id,recipient_id)
);
-- Transient acceptance intent fixes the actual command time across failed custody.
-- Exclude this table, reviews, credentials and command secrets from archives.
CREATE TABLE as_action_intents (
  command_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES as_requests(id),
  payload_digest TEXT NOT NULL, action TEXT NOT NULL CHECK(json_valid(action))
);
CREATE TABLE as_artifacts (
  request_id TEXT NOT NULL REFERENCES as_requests(id), artifact_id TEXT NOT NULL, version TEXT NOT NULL,
  reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
  phase TEXT NOT NULL CHECK(phase IN ('pending','retained')), intent_id TEXT NOT NULL,
  PRIMARY KEY(request_id,artifact_id,version)
);
CREATE TABLE as_events (
  request_id TEXT NOT NULL REFERENCES as_requests(id), sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 128),
  digest TEXT NOT NULL UNIQUE, previous TEXT, payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(request_id,sequence)
);
CREATE TABLE as_commands (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
  operation_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES as_requests(id) DEFERRABLE INITIALLY DEFERRED,
  result TEXT NOT NULL, sealed INTEGER NOT NULL CHECK(sealed IN (0,1)),
  guard INTEGER NOT NULL CHECK(guard=1),
  UNIQUE(actor_id,operation,operation_key)
);
CREATE TABLE as_external_executions (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES as_requests(id),
  provider TEXT NOT NULL, provider_request_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  UNIQUE(provider,provider_request_id)
);
-- Ephemeral assertions are inserted and removed in the SAME D1 batch. CHECK failure rolls it back.
CREATE TABLE as_transaction_guard (ok INTEGER NOT NULL CHECK(ok=1));
CREATE INDEX as_credentials_request ON as_credentials(request_id,recipient_id);
CREATE INDEX as_reviews_request ON as_reviews(request_id,recipient_id);
CREATE TRIGGER as_request_snapshot BEFORE UPDATE OF id,record_kind,definition,legacy,created_at ON as_requests
BEGIN SELECT RAISE(ABORT,'immutable signing snapshot'); END;
CREATE TRIGGER as_source_immutable BEFORE UPDATE ON as_source_map
BEGIN SELECT RAISE(ABORT,'immutable signing source'); END;
CREATE TRIGGER as_document_immutable BEFORE UPDATE ON as_documents
BEGIN SELECT RAISE(ABORT,'immutable signing document'); END;
CREATE TRIGGER as_recipient_immutable BEFORE UPDATE ON as_recipients
BEGIN SELECT RAISE(ABORT,'immutable signing participant'); END;
CREATE TRIGGER as_action_immutable BEFORE UPDATE ON as_actions
BEGIN SELECT RAISE(ABORT,'immutable signing action'); END;
CREATE TRIGGER as_event_immutable BEFORE UPDATE ON as_events
BEGIN SELECT RAISE(ABORT,'immutable signing event'); END;
CREATE TRIGGER as_command_immutable BEFORE UPDATE ON as_commands
BEGIN SELECT RAISE(ABORT,'immutable signing outcome'); END;
CREATE TRIGGER as_execution_immutable BEFORE UPDATE ON as_external_executions
BEGIN SELECT RAISE(ABORT,'immutable external execution'); END;
CREATE TRIGGER as_artifact_identity BEFORE UPDATE OF request_id,artifact_id,version,reference_json,intent_id ON as_artifacts
BEGIN SELECT RAISE(ABORT,'immutable signing artifact'); END;
