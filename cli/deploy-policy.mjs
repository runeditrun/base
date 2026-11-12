import { deployEnvironment } from './deploy-inputs.mjs';
import { invalid } from './errors.mjs';

// Seed policy is separate from uploading: secret-only commands bypass the
// deploy hook, but must not bypass a seed's applicable local input policy.
export async function enforceDeployPolicy({ adapter, root, options, setupManifest, localOnlyKeys, declaration, declarationPath, settings }) {
 if (adapter.deployPolicy === undefined) return;
 if (typeof adapter.deployPolicy !== 'function') throw invalid('The adapter deployPolicy must be a function.');
 const { env } = await deployEnvironment({ root, options, declaration, setupManifest, settings, localOnlyKeys });
 // Resolve declared environment aliases before policy sees Worker bindings.
 // Arbitrary ambient binding-name values never override an explicit mapping.
 const bindings = { ...declaration.vars };
 for (const secret of declaration.secrets ?? []) {
  if (env[secret.environment]?.trim()) bindings[secret.binding] = env[secret.environment];
 }
 await adapter.deployPolicy({ root, options: { ...options }, environment: options.environment ?? 'production', env, bindings, declaration, declarationPath });
}
