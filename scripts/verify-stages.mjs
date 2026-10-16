// Stages use independent temporary consumers/stores. Start the longest first;
// keep each stage's own file-concurrency limits and the reference build order.
export const verifyStages = [
  'modules', 'cli', 'portability', 'release', 'reference', 'editor',
  'foundation', 'review-harness', 'publish-check', 'operator-auth', 'onboarding',
  'onboarding-browser', 'composition', 'edition-authoring', 'authoring',
  'job-queue', 'owner-claim', 'boundary-checker', 'delivery-producer',
  'operations', 'deployment', 'launcher', 'schema', 'mail-relay', 'rer',
].map(name => `verify:${name}`);
