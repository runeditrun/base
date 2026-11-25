// Both deploy paths render the shared resolver's complete missing-input list.
export function secretFailureMessage(error) {
 if (error.message === 'token-scope-missing-workers') return `Cannot read the target's secret list; required secret bindings could not be checked. The Cloudflare token needs Workers Scripts permission (${error.message}). Nothing was uploaded.`;
 const first = /^missing-secret-([A-Z][A-Z0-9_]*)$/.exec(error.message)?.[1];
 if (!first) return;
 const names = error.missingSecrets?.map(({binding,environment}) => binding === environment ? binding : `${binding} (${environment})`) ?? [first];
 return `Deploy needs ${names.join(', ')}, which the deploy declaration lists as ${names.length === 1 ? 'a secret' : 'secrets'} and the Worker does not hold. Set ${names.length === 1 ? 'its value' : 'their values'} in the named environment inputs or in an --env-file file (an owned 0600 file of KEY=VALUE lines), then run the same command again. Nothing was uploaded.`;
}

/** A secret change the record holds as unfinished, or a copy rer refused to deploy: what to run next.
 * `deploy` is this environment's deploy command; `then` the command to repeat afterwards, if any. */
export function secretChangeMessage(error, deploy, then) {
 const change = error.pendingChange;
 if (!change || !Array.isArray(change.bindings)) return;
 const flag = change.present ? '--set-secret' : '--unset-secret', names = change.bindings.join(',');
 const finish = `${deploy} ${flag} ${names}`;
 if (error.message === 'secret-change-unsettled') return `The secret change ${flag} ${names} is recorded but not settled: rer has not yet confirmed that the live Worker version is that change. Run ${finish} again${change.present ? ' with the same values' : ''}: it finishes the change (deploying the copy already uploaded, if any) and records it.${then && then !== finish ? ` Then run ${then} again.` : ''}`;
 if (error.message === 'secret-copy-settings-changed') return `Cloudflare's new Worker version for ${flag} ${names} did not keep the live version's ${error.drift?.length ? error.drift.join(', ') : 'settings'}, so rer did not deploy it; the live Worker keeps its secrets and settings, and the deployment record is unchanged. This is a fault in rer and running the command again will not help: report this message to the RER platform. Until it is fixed, the undeployed version stays the Worker's newest, and Cloudflare can refuse a one-secret change until a deploy makes a version live again.`;
}
