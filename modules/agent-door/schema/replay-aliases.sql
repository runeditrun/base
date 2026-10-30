-- Installation-private replay custody, never included in an archive or export.
-- No expiry: the association replaces Base's existing indefinite replay claim.
CREATE TABLE IF NOT EXISTS agent_door_replay_aliases (
  agent TEXT NOT NULL, alias TEXT NOT NULL, call_id TEXT NOT NULL, tombstone TEXT NOT NULL,
  PRIMARY KEY(agent,alias)
);
