-- BASE-AGENT-014: the value-free decision projection the paired Business reads.
-- `change` is the read cursor; a call moves to a new change whenever its
-- projection changes. `pairing` is the owner-claim trust and Business the call
-- was first recorded under, or null while unpaired. No subject values are held.
CREATE TABLE IF NOT EXISTS agent_door_decisions (
  change INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, pairing TEXT, projection TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_door_decisions_pairing ON agent_door_decisions(pairing,change);
