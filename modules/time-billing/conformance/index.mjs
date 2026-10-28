import { observedDuration } from './observed-duration.mjs';
import { reviewCorrection } from './review-correction.mjs';
import { ratingClaims } from './rating-claims.mjs';
import { upgradeRestore } from './upgrade-restore.mjs';
import { withRuntime } from './assert.mjs';

/** Register four public-door flows against the adopter's real Worker and D1. */
export function registerTimeBillingConformance({ test, adapter }) {
  if (typeof test !== 'function' || typeof adapter?.open !== 'function' || !Array.isArray(adapter.profiles) || !adapter.profiles.length) throw new TypeError('A test registrar, runtime adapter and applicable profiles are required.');
  for (const profile of adapter.profiles) {
    if (!profile.id || !profile.policyId || typeof profile.review !== 'boolean' || typeof profile.timer !== 'boolean' || typeof profile.billing !== 'boolean') throw new TypeError('Declare the profile capabilities explicitly.');
  }
  test('time-billing: observed duration, identity and current native authority', () => withRuntime(adapter, observedDuration));
  test('time-billing: exact review, additive correction and period lock', () => withRuntime(adapter, reviewCorrection));
  test('time-billing: exact rating and a source claimed once', () => withRuntime(adapter, ratingClaims));
  test('time-billing: populated upgrade, export and inert restore', () => withRuntime(adapter, upgradeRestore, { populatedUpgrade: true }));
}
