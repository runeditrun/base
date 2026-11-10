-- Value-free tombstones of people erased from the installation: domain-separated SHA-256 digests of the roster
-- address and the Business member id, with the invite number they had. Never a name, address or id.
CREATE TABLE bs_retired (
  digest TEXT PRIMARY KEY,
  invite INTEGER NOT NULL CHECK(invite >= 0),
  erasure_id TEXT NOT NULL
);
-- Roster people the installation erased before this release: their native operator is gone, the Business
-- roster row and the stored document entry still hold them. Purge both by the dangling native id, which needs
-- no knowledge of who they were. (SQLite has no hash, so a Business that still lists such a person can invite
-- them again. Erasures made after this release also keep the tombstone.)
UPDATE bs_settings SET document=json_set(document,'$.team',(SELECT json_group_array(json(member.value)) FROM json_each(bs_settings.document,'$.team') member
  WHERE coalesce(json_extract(member.value,'$.email'),'') NOT IN(SELECT email FROM bs_team WHERE operator_id IS NOT NULL AND operator_id NOT IN(SELECT id FROM oa_operators))
    AND coalesce(json_extract(member.value,'$.id'),'') NOT IN(SELECT business_id FROM bs_team WHERE business_id IS NOT NULL AND operator_id IS NOT NULL AND operator_id NOT IN(SELECT id FROM oa_operators))))
  WHERE document IS NOT NULL AND json_valid(document) AND json_type(document,'$.team')='array';
DELETE FROM bs_team WHERE operator_id IS NOT NULL AND operator_id NOT IN(SELECT id FROM oa_operators);
