import { audienceAndArithmetic } from './audience.mjs';
import { commitmentAndAuthority } from './commitment.mjs';
import { exportAndUpgrade } from './history.mjs';

const profiles = new Set(['CENTS_WHOLE', 'CENTS_THOUSANDTH', 'CENTS_MILLIONTH', 'EXACT_TWELVE', 'SIX_PLACE', 'RATIONAL_EIGHTEEN']);

/** Test-only adapter: public operations must dispatch to the adopter's real routes or commands. */
export function registerCatalogueOrderingConformance({ test, adapter }) {
  if (typeof test !== 'function' || typeof adapter?.open !== 'function') throw new TypeError('A test registrar and real runtime adapter are required.');
  if (!Array.isArray(adapter.profiles) || !adapter.profiles.length || adapter.profiles.some(profile => !profiles.has(profile)) || new Set(adapter.profiles).size !== adapter.profiles.length) {
    throw new TypeError('Explicitly opt in to the arithmetic profiles implemented by the native adopter.');
  }
  const flows = [
    ['catalogue audience, exact arithmetic and immutable native terms', audienceAndArithmetic],
    ['catalogue review revisions, current authority and atomic native commitment', commitmentAndAuthority],
    ['catalogue scoped export, populated upgrade and inert recovery', exportAndUpgrade],
  ];
  for (const [name, run] of flows) test(name, async () => {
    const runtime = await adapter.open();
    try {
      if (typeof runtime?.request !== 'function' || typeof runtime?.close !== 'function') throw new TypeError('The runtime must implement its real public request() and close().');
      const cases = runtime.fixture?.profiles;
      if (!Array.isArray(cases) || !cases.length || cases.some(example => !adapter.profiles.includes(example.profile)) || adapter.profiles.some(profile => !cases.some(example => example.profile === profile))) {
        throw new TypeError('Each explicitly supported profile requires a real native public selection example.');
      }
      for (const method of ['changeCommercialFacts','setMembership','setNativeCommitAllowed','effects','verifyArtifact','restore']) {
        if (typeof runtime.controls?.[method] !== 'function') throw new TypeError(`The test-private adapter must implement ${method}().`);
      }
      await run(runtime);
    } finally { if (typeof runtime?.close === 'function') await runtime.close(); }
  });
}
