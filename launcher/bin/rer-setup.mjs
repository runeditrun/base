#!/usr/bin/env node
import { parseArgs, help } from '../lib/options.mjs';
import { acquire } from '../lib/acquire.mjs';
import { launchInstaller } from '../lib/launch.mjs';

let interrupted;
try {
  if (process.argv.slice(2).includes('--help')) console.log(help);
  else {
    const options = parseArgs(process.argv.slice(2));
    const controller = new AbortController();
    const interrupt = () => { interrupted = 130; controller.abort(); };
    const terminate = () => { interrupted = 143; controller.abort(); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    let receipt;
    try { receipt = await acquire({ ...options, signal: controller.signal }); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    console.log(`Source retained in ${options.directory}\nUpstream commit: ${receipt.commit}\nOpening ${options.seed} setup; installation still requires your approval.`);
    process.exitCode = await launchInstaller(options.directory, options.installerArgs);
  }
} catch (error) {
  console.error(`Setup could not start: ${error.message}`);
  process.exitCode = interrupted || 1;
}
