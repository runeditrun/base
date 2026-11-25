// Stages use independent temporary consumers/stores. Start the longest first.
export const verifyStages = ['reference', 'tests', 'publish-check'].map(name => `verify:${name}`);
