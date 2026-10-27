import { registerOperatorAuthConformance } from '../conformance/index.mjs';
import { openConformanceRuntime } from '../conformance/tests/runtime.mjs';

// The same public-door assertions run as adopting-runtime rows of the matching
// module journeys. Future unclassified cases remain standalone registrations.
export const conformanceGroups = { email: [], invitation: [], presentation: [], oidc: [] };
export const standaloneConformance = [];
registerOperatorAuthConformance({
  test(name, run) {
    const group = name.startsWith('magic-link preview') || name.startsWith('allow-list masking')
      || name.startsWith('local review rejects') || name.startsWith('IF-056 ') ? 'email'
      : name.startsWith('default roles constrain') ? 'invitation'
      : name.startsWith('confirmation and multipart mail') ? 'presentation'
      : name.startsWith('optional verified OIDC admission') ? 'oidc' : null;
    (group ? conformanceGroups[group] : standaloneConformance).push([name, run]);
  },
  adapter: { oidcIssuer: 'https://idp.conformance.test', open: openConformanceRuntime },
});
