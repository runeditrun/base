import { operatorInstaller, developmentTarget, previewTarget } from '../base-onboarding/operator-installer.mjs';
import { commandAdapter as createCommandAdapter } from '../base-cli/cli/adapter.mjs';
import { ownerDeploy } from '../base-cli/cli/deploy.mjs';
import { localPortability } from '../base-cli/cli/portability.mjs';
import * as model from './ui/seed.mjs';
import { portabilityPolicy } from '../../src/core/platform/portability-policy.mjs';

const lifecycle = operatorInstaller({ database: 'default-seed-reference', features: model.features });
export const adapter = lifecycle;
export const { install } = lifecycle;
export const commandAdapter = createCommandAdapter(lifecycle, {
 dev: developmentTarget, preview: previewTarget, verify: ['pnpm', ['run', 'verify:app']], deploy: ownerDeploy('deploy.json', lifecycle),
 // Portable-hosting moves use the shared archive policy and its default identity exclusions.
 // The destination claims a fresh owner and re-links authentication explicitly.
 portability: localPortability({ database: 'default-seed-reference', buckets: { FILES: 'FILES' }, policy: portabilityPolicy, transient: ['JOBS delivery attempts (durable jobs are included)', 'local runtime caches and logs'] }),

 setup: { manifestFile: 'rer-setup.json' }, browserModule: 'scripts/installer/ui/seed.mjs',
 // The hydration check starts from the React pages: `/` is the server-rendered Lobby.
 publicPages: ['/records', '/reference'],
 // The run site (rer build --site, rer deploy --site, RER_SITE): pages from
 // edition identity and Run data, written to an ignored folder; its domain is in deploy-site.json.
 site: { entry: 'src/site/pages.ts', output: 'dist/site', declaration: 'deploy-site.json' },
 // Local dev identity: the local-only Worker entry, the build output rer build
 // scans for the dev layer, and the kept end-to-end email-link test.
 devIdentity: { entry: 'src/server.dev.ts', output: ['dist'], emailLinkTest: 'tests/local-journey/journey.test.mjs' },
 localOnlyKeys: ['RER_DEV_ORIGIN', 'RER_DEV_IDENTITY'],
 product: model.product.name, input: { names: { email: 'OWNER_EMAIL', name: 'displayName' } },
});
