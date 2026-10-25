// What a person does about each migration-history refusal (portability-migrations.mjs, modules/portability/ledgers.mjs).
// Codes are constant categories; a migration named by an archive or the checkout follows the second colon.
const fixes = {
 unknown: 'the archive records a migration whose file name or content this checkout does not have. Restore with the checkout version that exported it (or a later one), with its migration files unchanged.',
 conflict: 'a migration in the archive has the name of one checkout file and the content of another. Restore with the checkout version that exported it, with its migration files unchanged.',
 ambiguous: 'one migration identity matches several checkout files or ledger entries. Keep a single file per migration and declare the seed\'s migration prefix.',
 unapplied: 'the installation\'s history lacks a migration this checkout ships. Apply it with the runner that owns the history (RER Platform for a Managed installation), then retry.',
 multiple: 'the database holds more than one migration ledger. Reconcile its history with the runner that owns it.',
 uncertain: 'a migration was left partly applied. Finish or roll back that operation with its runner, then retry.',
 runner: 'the history belongs to the older Base deploy runner, which can adopt it. Use that runner first.',
 incompatible: 'the migration ledger or the checkout declaration has an unsupported shape. Use the matching checkout and its declaration.',
 binding: 'the checkout declares no single D1 binding with that name. Use the matching checkout.',
};
export function ledgerRefusal(receipt) {
 const [, kind, ...name] = receipt.reason.split(':');
 const named = receipt.unapplied ?? (name.length ? name.join(':') : undefined);
 return `Migration history refused (${receipt.reason}): ${named ? `migration ${named}: ` : ''}${fixes[kind] ?? 'its history does not match this checkout.'}`;
}
