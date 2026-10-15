import { verbs } from '../cli/contract.mjs';
import { dispatcher, locate, pinnedPackage, unsupportedMessage } from './checkout.mjs';
import { delegate } from './delegate.mjs';
import { localDefaults } from './launch/local-defaults.mjs';
import { handleBrokenPipes } from './output.mjs';

const help = `Usage: rer VERB [FLAGS]

Inside a project (the nearest OPERATIONS.json at or above this folder, or --cwd DIR),
every verb runs that checkout's own pinned rer: the @runeditrun/rer version its package.json
pins (installed first by any verb when node_modules holds another), else its vendored scripts/rer.mjs.

  rer dev              Launch a first-party checkout with no setup steps: installs dependencies,
                       sets up a local owner and a free port when needed, starts the app and prints
                       RER_READY and a sign-in link. Without a terminal it returns once the app is
                       ready and leaves it running (--detach and --foreground override); allow up
                       to 10 minutes on a first launch, or rerun it to reattach. rer dev --stop stops it.
  rer list [DIR]       The checkouts in DIR (default: here), newest first, with whether rer dev can
                       launch them, whether they are set up, and their running URL. --json for data.
  rer door ...         The opt-in front door: every checkout at http://NAME.localhost:PORT, started
                       on its first visit and stopped when idle. rer door --help for its verbs.
  rer cli status       This rer: version, contents digest, install channel, launcher and other rer
                       commands on PATH. --json for data.
  rer cli install      Install this package for the current user (~/.local/bin/rer).
  rer cli uninstall    Remove the launcher and the install root; ~/.rer is untouched.
  rer update           Move to the latest published rer (--version X for an exact one), the way it
                       was installed: npx and install.sh installs switch atomically, npm installs run npm.
  rer --version        Print this rer's version; inside a checkout, also the version the checkout pins.
  rer queue NAME -- COMMAND [ARGS]
                       Run COMMAND once this computer's job queue admits it (heavy package scripts
                       of a checkout that pins the rer package use it).

Checkout verbs: install, setup, dev, demo, preview, build, verify, reset, deploy, signin, export,
import, doctor, describe, check, release. Run rer VERB --help in a checkout for its flags.
`;

// The checkout verbs that install the pinned package before they run when
// node_modules holds another version or none (dev installs it in its launch).
const installsFirst = new Set([...Object.keys(verbs), 'signin', 'release'].filter(verb => !['dev', 'doctor'].includes(verb)));

export async function main(argv) {
 handleBrokenPipes();
 const [verb] = argv;
 if (verb === '--version' || verb === '-v') return (await import('./version.mjs')).versionCommand(argv);
 if (verb === 'queue' && argv.length === 2 && argv[1] === '--help') {
  process.stdout.write('Usage: rer queue NAME -- COMMAND [ARGS]\nRun COMMAND once this computer\'s job queue admits it.\n');
  return 0;
 }
 // Only the zero-setup launch sets this, for its own setup child; an explicit
 // verb never inherits it.
 delete process.env[localDefaults];
 if (verb === 'update') return (await import('./update/command.mjs')).update(argv.slice(1));
 const notice = await import('./update/notice.mjs');
 if (verb !== 'doctor' && notice.wantsNotice(argv)) await notice.updateNotice();
 if (!verb || verb === '--help' || verb === '-h' || verb === 'help') { process.stdout.write(help); return 0; }
 if (verb === 'cli') return (await import('./cli/command.mjs')).cliCommand(argv.slice(1));
 if (verb === 'list') return (await import('./list.mjs')).listCommand(argv.slice(1));
 if (verb === 'door') return (await import('./door/command.mjs')).doorCommand(argv.slice(1));
 const target = locate(argv);
 if (target.profile === 'unsupported') { process.stderr.write(unsupportedMessage(target.root, target.version) + '\n'); return 2; }
 const first = target.profile === 'first-party', mode = first ? dispatcher(target.root).mode : undefined;
 if (first) {
  // Carry the effective directories to older dispatchers that used account HOME.
  const { serversDirectory } = await import('./registry.mjs');
  const { jobsDirectory } = await import('../modules/job-queue/config.mjs');
  process.env.RER_SERVERS_DIR = serversDirectory(process.env);
  process.env.RER_JOBS_DIR = jobsDirectory(process.env);
  if ((mode !== 'bundled' || pinnedPackage(target.root)) && verb === 'doctor' && !argv.includes('--help')) {
   const { parse } = await import('../cli/parse.mjs');
   try { parse(target.args, target.root); }
   catch (error) { process.stderr.write(error.message + '\n'); return error.exitCode ?? 2; }
   const code = await (await import('./browser-runtime.mjs')).browserPreflight(target.root, target.args);
   if (code !== undefined) return code;
  }
  const bootstrap = pinnedPackage(target.root)?.ready === false && installsFirst.has(verb);
  if ((bootstrap || ['install', 'setup', 'dev', 'preview', 'build', 'verify'].includes(verb)) && !argv.includes('--help') && !argv.includes('--stop')) {
   const { parse } = await import('../cli/parse.mjs');
   // The door's launch marker belongs to launchDev, which consumes it before
   // calling the checkout's public dispatcher. Validate the same public args
   // here, before provisioning the checkout's package manager.
   const publicArgs = verb === 'dev' ? target.args.filter(arg => arg !== '--door-start') : target.args;
   try { parse(publicArgs, target.root); }
   catch (error) { process.stderr.write(error.message + '\n'); return error.exitCode ?? 2; }
   const { ensureProjectPnpm } = await import('../cli/project-pnpm.mjs');
   const { RerError } = await import('../cli/errors.mjs');
   try { await ensureProjectPnpm(target.root, { report: text => process.stderr.write(text + '\n') }); }
   catch (error) { if (!(error instanceof RerError)) throw error; process.stderr.write(error.message + '\n'); return error.exitCode; }
  }
 }
 if (verb === 'queue') {
  const [, name, separator, command] = argv;
  if (!name || separator !== '--' || !command) { process.stderr.write('Usage: rer queue NAME -- COMMAND [ARGS]\n'); return 2; }
  if (mode === 'package') return delegate(target, target.args);
  return (await import('../onboarding/queued-entry.mjs')).queuedCommandLine(argv.slice(1));
 }
 // A checkout that pins its own rer package runs all of it, launching included.
 // Until node_modules holds the pinned version (a fresh clone, or a pulled pin
 // change), every checkout verb installs it with the frozen lockfile and then
 // runs the pinned verb, so a fresh clone checks and a changed pin deploys with
 // the pinned bytes; the zero-setup launch installs it first.
 // Verbs started at once share one install, and one whose pin already looks
 // installed waits for an install still running.
 const pinned = first && mode !== 'package' ? pinnedPackage(target.root) : undefined;
 if (pinned && !pinned.ready && !argv.includes('--help') && installsFirst.has(verb)) {
  const { installPinned } = await import('./launch/install-pinned.mjs'), { LaunchFailure } = await import('./launch/failure.mjs');
  try { await installPinned(target.root); }
  catch (failure) { if (!(failure instanceof LaunchFailure)) throw failure; process.stderr.write(failure.message + '\n'); return failure.exitCode; }
 }
 if (mode === 'package' && installsFirst.has(verb)) await (await import('./launch/install-pinned.mjs')).settledPin(target.root);
 if (first && dispatcher(target.root).mode !== 'bundled' && ['install', 'verify'].includes(verb) && !argv.includes('--help') && !argv.includes('--site')) {
  const code = await (await import('./browser-runtime.mjs')).browserPreflight(target.root, target.args);
  if (code !== undefined) return code;
 }
 if (verb === 'dev' && mode && mode !== 'package' && !argv.includes('--help')) return (await import('./launch/dev.mjs')).launchDev(target);
 // Every other server start or queued job on a vendored pin gets the person
 // defaults too (a pinned package applies its own).
 if (mode === 'vendored') {
  const { personEnvironment, personVerbs, pinPolicy } = await import('./launch/capacity.mjs');
  if (personVerbs.has(verb)) Object.assign(process.env, personEnvironment(process.env, target.args, await pinPolicy(target.root, mode)));
 }
 await delegate(target, target.args);
}
