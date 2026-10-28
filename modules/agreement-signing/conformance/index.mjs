import { profiles, check, withRuntime } from './helpers.mjs';
import { exactSourceParticipant } from './exact.mjs';
import { orderingConcurrentRedemption } from './ordering.mjs';
import { replacementWithdrawal, expiry } from './lifecycle.mjs';
import { custodyUpgradeRestore } from './custody.mjs';

/** Black-box flows: the adapter must dispatch the adopter's actual public commands/routes. */
export function registerAgreementSigningConformance({ test, adapter }) {
  check(typeof test === 'function', 'A test registrar is required.');
  check(typeof adapter?.open === 'function', 'A real consumer runtime adapter is required.');
  check(Array.isArray(adapter.profiles) && adapter.profiles.length > 0, 'Declare the supported signing profiles explicitly.');
  for (const profile of adapter.profiles) check(profiles.includes(profile), `Unsupported signing conformance profile: ${profile}`);
  check(new Set(adapter.profiles).size === adapter.profiles.length, 'Signing profiles must not be duplicated.');

  test('agreement signing: exact source/selection and native participant authority', async () => {
    for (const profile of adapter.profiles) await withRuntime(adapter, profile, exactSourceParticipant);
  });
  test('agreement signing: ordered/parallel participants and concurrent one-use redemption', async () => {
    for (const profile of adapter.profiles) await withRuntime(adapter, profile, orderingConcurrentRedemption);
  });
  test('agreement signing: replacement, expiry and withdrawal retain earlier evidence', async () => {
    for (const profile of adapter.profiles) {
      await withRuntime(adapter, profile, replacementWithdrawal);
      await withRuntime(adapter, profile, expiry, { expiresInMs: 2200 });
    }
  });
  test('agreement signing: immutable custody, populated forward upgrade and inert restore', async () => {
    for (const profile of adapter.profiles) await withRuntime(adapter, profile, runtime => custodyUpgradeRestore(adapter, profile, runtime));
  });
}
