// One archive policy for `rer export`/`rer import` and the Worker's erasure fence.
export const portabilityPolicy = {
  product: 'runeditrun/default-seed',
  excludeTables: ['operators', 'sessions', 'rer_dependency_keys', 'rer_dependency_pending', 'rer_dependency_codes', 'rer_erasure_blobs', 'rer_erasure_guard', 'rer_erasure_scope'],
  requiredConfiguration: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN', 'AUTH_ORIGIN', 'MAIL_PROVIDER', 'MAIL_FROM'],
  buckets: { FILES: { prefix: 'people/', objectReferences: { table: 'person_files', keyColumn: 'storage_key' } } },
}
