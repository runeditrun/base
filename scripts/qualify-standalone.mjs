#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { deployDescriptor, insist } from './qualification/operations.mjs';
import { hostedOrigin, healthAndWidget } from './qualification/http.mjs';

// Credential-free command-library smoke check for explicitly trusted local
// callers. The hosted CLI below always uses the reviewed Linux executor.
export async function qualifyStandalone({ directory, origin, env, remoteSelection, widgetPath, journey, observe }) {
  hostedOrigin(origin);
  insist(typeof journey === 'function', 'seed-journey-unconfigured');
  const descriptor = deployDescriptor({ cwd: directory, env, remoteSelection, observe });
  await healthAndWidget(origin, descriptor, widgetPath);
  await journey({ origin, directory, env, observe });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
      console.log(`Usage:
  node scripts/qualify-standalone.mjs --seed happytohelp
  node scripts/qualify-standalone.mjs --seed <seed> --directory <path> --origin <https-origin> --widget-path <path> --adapter <reviewed-adapter> [--target remote]

Hosted qualification requires the reviewed Linux executor and provisioned provider inputs.
--help is credential-free and does not execute qualification.`);
    } else if (args.length === 2 && args[0] === '--seed' && args[1] === 'happytohelp') {
      const { runT016 } = await import('../live-proofs/t016/run.mjs');
      const result = await runT016('t016-r2-on');
      // Only bounded observations from the trusted runner. No provider logs.
      console.log(JSON.stringify(result));
      if (result.result !== 'passed') process.exitCode = 1;
    } else {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        insist(['--seed', '--directory', '--origin', '--widget-path', '--adapter', '--target'].includes(args[i]) &&
          !Object.hasOwn(options, args[i]) && args[i + 1], 'invalid-options');
        options[args[i]] = args[i + 1];
      }
      insist(options['--directory'] && options['--origin'] && options['--widget-path'] && options['--adapter'], 'alternate-seed-unconfigured');
      insist(!options['--target'] || options['--target'] === 'remote', 'invalid-target');
      const { runStandalone } = await import('../live-proofs/standalone/run.mjs');
      await runStandalone({ seed: options['--seed'], directory: options['--directory'], origin: options['--origin'],
        adapter: options['--adapter'], target: options['--target'], widgetPath: options['--widget-path'] });
      console.log('Reviewed descriptor deployment and hosted journey completed. This is not a T016 acceptance receipt.');
    }
  } catch { console.error('Standalone qualification failed.'); process.exitCode = 1; }
}
