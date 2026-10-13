CREATE TABLE rer_erasure_operations (
  id TEXT PRIMARY KEY NOT NULL,
  entity TEXT NOT NULL,
  subject TEXT,
  label TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('deleting','blobs','complete')),
  step INTEGER NOT NULL DEFAULT 0,
  planned TEXT NOT NULL,
  deleted TEXT NOT NULL DEFAULT '{}',
  retained TEXT NOT NULL,
  blobs_total INTEGER NOT NULL DEFAULT 0,
  blobs_deleted INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  committed_at TEXT,
  completed_at TEXT
);
CREATE UNIQUE INDEX rer_erasure_active_subject ON rer_erasure_operations(entity,subject) WHERE subject IS NOT NULL;
CREATE TABLE rer_erasure_blobs (
  operation TEXT NOT NULL, bucket TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(operation,bucket,key)
);
CREATE TABLE rer_erasure_guard (value INTEGER NOT NULL CHECK(value=1));
