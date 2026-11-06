/** Apply in a NEW numbered edition migration after importDoorSchema. No
 * existing table or ledger row is changed. Omitted feature mounts keep v1. */
export const importDoorBoundedWavesMigration = [
  `CREATE TABLE IF NOT EXISTS ik_door_wave_roots (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, namespace TEXT NOT NULL,
    destination TEXT NOT NULL, owner TEXT NOT NULL, mapping_version TEXT NOT NULL,
    bundle_sha256 TEXT NOT NULL, upload_id TEXT NOT NULL, previous_id TEXT,
    epoch INTEGER NOT NULL, binding_json TEXT NOT NULL, census_json TEXT NOT NULL,
    fingerprint TEXT, state TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 0,
    chain TEXT NOT NULL, catchup INTEGER NOT NULL DEFAULT 0, content_revision INTEGER NOT NULL DEFAULT 0,
    UNIQUE(installation_id,namespace,upload_id,binding_json))`,
  "CREATE UNIQUE INDEX IF NOT EXISTS ik_door_wave_revision ON ik_door_wave_roots(installation_id,namespace,json_extract(binding_json,'$.migration'),json_extract(binding_json,'$.revision'))",
  `CREATE TABLE IF NOT EXISTS ik_door_wave_children (
    parent_id TEXT NOT NULL REFERENCES ik_door_wave_roots(id), ordinal INTEGER NOT NULL,
    plan_id TEXT NOT NULL UNIQUE REFERENCES ik_door_plans(id), unit_hash TEXT NOT NULL,
    fingerprint TEXT NOT NULL, descriptor_hash TEXT NOT NULL,
    source INTEGER NOT NULL, native INTEGER NOT NULL, aliases INTEGER NOT NULL, objects INTEGER NOT NULL,
    logicalBytes INTEGER NOT NULL, storedBytes INTEGER NOT NULL, nativeBytes INTEGER NOT NULL, blobBytes INTEGER NOT NULL,
    contextBytes INTEGER NOT NULL, PRIMARY KEY(parent_id,ordinal), UNIQUE(parent_id,unit_hash))`,
  `CREATE TABLE IF NOT EXISTS ik_door_wave_members (
    parent_id TEXT NOT NULL REFERENCES ik_door_wave_roots(id), type TEXT NOT NULL,
    identity TEXT NOT NULL, digest TEXT NOT NULL, ordinal INTEGER NOT NULL,
    PRIMARY KEY(parent_id,type,identity))`,
  'CREATE INDEX IF NOT EXISTS ik_door_wave_digest ON ik_door_wave_members(parent_id,digest)',
  `CREATE TABLE IF NOT EXISTS ik_door_wave_approvals (
    parent_id TEXT NOT NULL REFERENCES ik_door_wave_roots(id), ordinal INTEGER NOT NULL,
    approval_id TEXT NOT NULL, approved_at TEXT NOT NULL, owner TEXT NOT NULL,
    fingerprint TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(parent_id,ordinal))`,
  `CREATE TABLE IF NOT EXISTS ik_door_wave_erased_aliases (installation_id TEXT NOT NULL, namespace TEXT NOT NULL, destination TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(installation_id,namespace,destination,identity))`,
  `CREATE TABLE IF NOT EXISTS ik_door_wave_origins (
    job_id TEXT PRIMARY KEY REFERENCES ik_jobs(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, plan_id TEXT NOT NULL, fingerprint TEXT NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_origin_update BEFORE UPDATE ON ik_door_wave_origins
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_ORIGIN_CHANGED'); END`,
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_origin_delete BEFORE DELETE ON ik_door_wave_origins
    WHEN EXISTS(SELECT 1 FROM ik_jobs WHERE id=old.job_id)
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_ORIGIN_CHANGED'); END`,
  ...['INSERT','UPDATE'].map(event=>`CREATE TRIGGER IF NOT EXISTS ik_door_wave_epoch_${event.toLowerCase()} BEFORE ${event} ON ik_door_wave_roots
    WHEN new.state NOT IN ('withdrawn','cancelled') AND new.epoch<(SELECT count(*) FROM ik_d1_erasure_journal WHERE destination=new.destination)
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_ERASURE_FENCE'); END`),
  ...['ik_door_wave_children','ik_door_wave_members'].flatMap(table=>['UPDATE','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS ${table}_${event.toLowerCase()} BEFORE ${event} ON ${table}
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_MEMBERSHIP_IMMUTABLE'); END`)),
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_root_binding BEFORE UPDATE ON ik_door_wave_roots
    WHEN ${['id','installation_id','namespace','destination','owner','mapping_version','bundle_sha256','upload_id','previous_id','epoch','binding_json','census_json','catchup'].map(k=>`new.${k} IS NOT old.${k}`).join(' OR ')}
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_BINDING_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_root_layout BEFORE UPDATE ON ik_door_wave_roots
    WHEN old.state<>'preparing' AND (new.pages<>old.pages OR new.chain<>old.chain OR new.fingerprint IS NOT old.fingerprint)
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_MEMBERSHIP_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_approval_update BEFORE UPDATE ON ik_door_wave_approvals
    WHEN ${['parent_id','ordinal','approval_id','approved_at','owner','fingerprint'].map(k=>`new.${k} IS NOT old.${k}`).join(' OR ')} OR new.revoked<old.revoked
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_APPROVAL_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_approval_delete BEFORE DELETE ON ik_door_wave_approvals
    BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_APPROVAL_IMMUTABLE'); END`,
  ...['ik_door_wave_children','ik_door_wave_members'].map(table=>`CREATE TRIGGER IF NOT EXISTS ${table}_revision AFTER INSERT ON ${table}
    BEGIN UPDATE ik_door_wave_roots SET content_revision=content_revision+1 WHERE id=new.parent_id; END`),
  ...['INSERT','UPDATE','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS ik_door_wave_content_${event.toLowerCase()} AFTER ${event} ON ik_door_plan_chunks
    BEGIN UPDATE ik_door_wave_roots SET content_revision=content_revision+1${event==='DELETE'?",state='withdrawn'":''}
      WHERE id IN (SELECT parent_id FROM ik_door_wave_children WHERE plan_id=${event==='DELETE'?'old':'new'}.plan_id); END`),
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_content_monotonic BEFORE UPDATE ON ik_door_wave_roots
    WHEN new.content_revision<old.content_revision BEGIN SELECT RAISE(ABORT,'IMPORT_WAVE_CONTENT_CHANGED'); END`,
  // The existing erasure transaction withdraws opaque snapshots and package
  // copies in its destination. This fence also withdraws an unfinished root:
  // it can never regain authority by re-uploading the same or corrected bytes.
  `CREATE TRIGGER IF NOT EXISTS ik_door_wave_withdraw AFTER DELETE ON ik_door_plan_chunks
    BEGIN UPDATE ik_door_wave_roots SET state='withdrawn' WHERE id IN
      (SELECT parent_id FROM ik_door_wave_children WHERE plan_id=old.plan_id)
      AND state NOT IN ('reversed','withdrawn'); END`,
];

/** A partial migration never enables execution without its immutable bindings. */
const objects=importDoorBoundedWavesMigration.map(query=>/^CREATE (?:UNIQUE )?(TABLE|TRIGGER|INDEX) IF NOT EXISTS (\w+)/.exec(query.trim())).filter((match):match is RegExpExecArray=>!!match);
export const importDoorBoundedWavesCheck=`SELECT count(*)=${objects.length} AS current FROM sqlite_master WHERE `+objects.map(match=>`(type='${match[1].toLowerCase()}' AND name='${match[2]}')`).join(' OR ');
