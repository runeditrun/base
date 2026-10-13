// rer --version: this rer's version on the first line. Inside a first-party
// checkout (or with --cwd DIR) a second line names the version that checkout
// pins: its package's, or the one its vendored copy recorded, which
// `rer describe` reports as cliVersion.
import { dispatcher, locate, pinnedPackage } from './checkout.mjs';
import { describeCheckout } from './launch/facts.mjs';
import { ownManifest } from './package-info.mjs';

export async function versionCommand(argv) {
 process.stdout.write(ownManifest().version + '\n');
 const target = locate(argv);
 if (target.profile !== 'first-party') return 0;
 const pinned = pinnedPackage(target.root);
 if (pinned) {
  process.stdout.write(pinned.ready
   ? `This checkout (${target.root}) pins rer ${pinned.installed} (package).\n`
   : `This checkout (${target.root}) pins rer ${pinned.declared} (package), ${pinned.installed ? `but node_modules holds ${pinned.installed}` : 'not installed yet'}: run rer install.\n`);
  return 0;
 }
 const { mode, entry } = dispatcher(target.root);
 if (mode === 'bundled') return 0;
 let described;
 try { described = await describeCheckout(target.root, entry, process.env); }
 catch (failure) { process.stdout.write(`This checkout (${target.root}): its pinned rer version could not be read: ${failure.message.split('\n')[0]}\n`); return 0; }
 process.stdout.write(described.cliVersion
  ? `This checkout (${target.root}) pins rer ${described.cliVersion} (vendored scripts/rer.mjs).\n`
  : `This checkout (${target.root}) pins an unversioned rer copy: its vendored scripts/rer.mjs is older than version recording. Refresh its vendored Base to record one.\n`);
 return 0;
}
