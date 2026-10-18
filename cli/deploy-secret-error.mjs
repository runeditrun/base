// Both deploy paths render the shared resolver's complete missing-input list.
export function secretFailureMessage(error) {
 if (error.message === 'token-scope-missing-workers') return `Cannot read the target's secret list; required secret bindings could not be checked. The Cloudflare token needs Workers Scripts permission (${error.message}). Nothing was uploaded.`;
 const first = /^missing-secret-([A-Z][A-Z0-9_]*)$/.exec(error.message)?.[1];
 if (!first) return;
 const names = error.missingSecrets?.map(({binding,environment}) => binding === environment ? binding : `${binding} (${environment})`) ?? [first];
 return `Deploy needs ${names.join(', ')}, which the deploy declaration lists as ${names.length === 1 ? 'a secret' : 'secrets'} and the Worker does not hold. Set ${names.length === 1 ? 'its value' : 'their values'} in the named environment inputs or in an --env-file file (an owned 0600 file of KEY=VALUE lines), then run the same command again. Nothing was uploaded.`;
}
