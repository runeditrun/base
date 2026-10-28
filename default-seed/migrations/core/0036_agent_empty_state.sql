-- Retire only the untouched placeholder from the first agent-door migration.
-- Configured policy, Pause and in-flight admission state remain intact.
DELETE FROM agent_door_state
WHERE id=1 AND envelope IS NULL AND local_document IS NULL
  AND local_revision=0 AND local_paused=0
  AND decision_lock IS NULL AND decision_until IS NULL;
