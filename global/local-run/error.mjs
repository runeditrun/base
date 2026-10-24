export const errorCodes = new Set(['get_failed', 'install_failed', 'database_failed', 'start_failed', 'refused', 'needs_input', 'stopped', 'release_unverified', 'release_not_found', 'worktree_dirty', 'not_on_branch', 'checkout_missing', 'migration_history_changed', 'needs_integration', 'prior_data_changed', 'health_failed', 'rolled_back', 'rollback_failed', 'rer_update_required', 'disk_low']);

export function failure(error_code) {
 if (!errorCodes.has(error_code)) error_code = 'refused';
 return Object.assign(new Error(error_code), { error_code, code: error_code });
}

export function phases(onPhase) {
 const started = Date.now();
 const steps = { get: 1, install: 2, database: 3, start: 4, ready: 4, failed: 4 };
 return async (phase, error_code) => {
  await onPhase?.({ phase, step: steps[phase], total: 4, elapsed_ms: Date.now() - started, ...(error_code ? { error_code } : {}) });
 };
}
