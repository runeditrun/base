import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyModuleURL } from './portability-policy.mjs';

// Packaging does not import the policy or run seed build configuration/plugins.
// Dependencies are compiled from this installation, never from archive metadata.
try {
 const [root,entry,outfile]=process.argv.slice(2);
 const require=createRequire(join(root,'package.json'));
 const { build }=createRequire(require.resolve('wrangler/package.json'))('esbuild');
 await build({absWorkingDir:root,entryPoints:[fileURLToPath(await policyModuleURL(root,entry))],outfile,
  bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
}catch{process.exitCode=1;}
