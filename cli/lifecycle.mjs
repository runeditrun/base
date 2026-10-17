import { ensureChromium } from './browser-runtime.mjs';
import { dependencyInputs } from './dependency-input.mjs';
import { linkDependencies } from './dependencies.mjs';
import { savedSetupAnswers } from './setup-answers.mjs';
import { localDefaultsVariable } from './setup-input.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shared } from './shared.mjs';
import { tools, doctor } from './inspect.mjs';
import { availablePort, selectedOrigin, setupInput, stateSafety, refuseLegacyProcess } from './local.mjs';
import { missing, refuse, RerError, lifecycleError } from './errors.mjs';
import { executeDeclared } from './independent.mjs';
import { transfer } from './transfers.mjs';
import { runtimeFrontDoor } from './runtime-front-door.mjs';
import { localCliSessionProof, localSettingKeys } from './settings.mjs';
import { rememberSetupAnswers } from './setup-answers.mjs';
import { ensureDevKey, refuseDevLayerOutput } from './dev-identity.mjs';
import { withoutLocalSettings, refuseLocalEnvOutput } from './local-env.mjs';
import { announceDoorRoute } from './door-mode.mjs';

export async function runCommand(project, options, out) {
 if (options.verb === 'deploy' && !options.site && !options.demo) {
  const { validateDeployOptions } = await import('./deploy-command.mjs');
  validateDeployOptions(options);
  const { withDeployEnvironment } = await import('./deploy-inputs.mjs');
  return withDeployEnvironment(project, options, out, redaction => runLifecycle(project, options, out, redaction));
 }
 return runLifecycle(project, options, out);
}

async function runLifecycle(project, options, out, deployRedaction) {
 if (project.profile === 'first-party' && ['build','deploy'].includes(options.verb) && !options.demo && !options.site && process.env.RER_DEMO) throw refuse('Production build and deploy refuse the local-only RER_DEMO environment binding. Unset it before retrying.');
 if(project.profile==='first-party'&&options.verb==='outbox')throw refuse('Captured mail has been retired. Run rer dev and open its RER_OPEN link.');
 if(project.profile==='first-party'&&['dev','preview'].includes(options.verb))return (await import('./managed-server.mjs')).managedServer(project,options,out);
 const cancellation = new AbortController(), signal = cancellation.signal;
 let termination, operation, store, temporary, proxy, failed = false;
 const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => { if (!termination) { termination = name; cancellation.abort(name); } }]));
 for (const [name, handler] of handlers) process.on(name, handler);
 try {
  let selected, input;
  if (project.profile === 'first-party') {
   if (project.adapter?.setup) {
    const { loadInstallerSeed } = await shared('setup-manifest.mjs');
    try { project.setupSeed = await loadInstallerSeed(project.root, project.adapter); }
    catch (error) { throw new RerError('invalid_setup_manifest', `The declared setup manifest or presentation is invalid. ${String(error.message).replace(/\.?$/, '.')} Correct or restore its sources before retrying.`, 2); }
    project.setupManifest = project.setupSeed.manifest;
   }
  }
  if (project.profile === 'first-party' && options.verb !== 'doctor') {
   if (!project.adapter?.run) throw refuse('The first-party command adapter is unavailable. Restore the shared lifecycle adapter.');
   if (options.forwarded.length) throw refuse('First-party commands do not accept arbitrary forwarded arguments. Run rer VERB --help.');
   await stateSafety(project);
   const { localOperation } = await shared('local/operation.mjs');
   // The run site reads no local state: it builds beside a running rer dev.
   if (!options.site) try { operation = await localOperation(project.root, process.env.RER_LOCAL_OPERATION); } catch (error) { throw refuse(error.message); }
   if(options.verb==='setup'||options.verb==='import'&&(options.target??'local')==='local'){
    const ownership=await refuseLegacyProcess(project,{verb:options.verb,operation});
    if(ownership?.lockProof)out.progress('Local process inspection did not answer; continuing with the exclusive checkout launch lock.\n');
   }
   if (options.verb === 'setup') {
    selected = await selectedOrigin(project, options, { setup: options.verb === 'setup' });
    if (options.verb === 'setup') {input = await setupInput(project, options, selected.vars, signal, { origin: selected.url });await dependencyInputs({project,input,origin:selected.url});}
    if (!selected.door) await availablePort(selected.host, selected.port, { root: project.root, saved: !selected.explicitPort && selected.savedOrigin !== undefined, verb:options.verb });
    if (options.verb === 'setup') announcePort(out, options, selected);
   }
   const { recoverInterrupted } = await shared('local/recovery.mjs');
   if (operation) await recoverInterrupted(project.root, operation);
   if (project.ownerReplacement) await replaceOwner(project, options, out);
  }
  const { createCommands } = await shared('commands.mjs');
  const { privateDirectory } = await shared('private-files.mjs');
  // Nested public commands stream into their caller's capture and keep their
  // own log separate, including the browser install/setup/preview journey.
  const capture = ['.seed', 'installer', ...(process.env.RER_LOCAL_OPERATION || process.env.RER_ONBOARDING_PROCESS_OWNER ? [`commands-${process.pid}`] : [])];
  const directory = project.profile === 'first-party' && options.verb !== 'doctor' ? await privateDirectory(project.root, capture) : (temporary = await mkdtemp(join(tmpdir(), 'rer-command-')));
  const state = { logs: [] };
  store = await createCommands(directory, state, { terminal: text => out.progress(text), onWaiting: options.json ? details => out.event('waiting', details) : undefined, queue: ['install','setup','build','verify','deploy','export','import'].includes(options.verb)?{verb:options.verb,originalCI:process.env.CI==='true'}:undefined });
  store.state = state;
  if (deployRedaction) store.addSecrets?.(Object.values(process.env).filter(value => value && deployRedaction.redact(value) !== value));
  store.setupManifest = project.setupManifest;
  store.step = async label => { state.step = store.redact(label); store.report(label); };
  store.phase = async phase => { state.phase = phase; };
  store.setCommandSignal(signal);
  if (options.verb === 'doctor') return await doctor(project, store, signal);
  if (project.profile === 'independent') return await executeDeclared(project, options, store, signal);
  await tools(project.root, store, signal);
  const adapter = project.adapter;
  // The run site: static pages built from edition identity, never the app build.
  if (options.site) return await (await import('./site.mjs')).siteCommand(project, options, store, signal, out);
  // The hosted demo: a native Worker Loader host on demo.<domain>.
  if (options.verb === 'deploy' && options.demo) return await (await import('./demo-host.mjs')).demoHostCommand(project, options, store, signal, out, operation);
  if (options.verb === 'install') {
   try {
    const { dependencyEnvironment } = await shared('dependency-environment.mjs');
    await store.run('Installing frozen dependencies', 'pnpm', ['install', '--frozen-lockfile'], { cwd: project.root, signal, env: { ...dependencyEnvironment(), CI: 'true' }, display: 'pnpm install --frozen-lockfile' });
    // The test browser downloads on first need (verify), not here. Package
    // scripts run with the pinned pnpm through rer run, which keeps pnpm off PATH.
    if (!options.json) store.report('Run this project\'s package scripts with rer run SCRIPT (it uses the pnpm this project pins).');
    return {};
   } catch (error) { if (signal.aborted) throw error; throw await installStepError(error, store, project.root); }
  }
  if (options.verb === 'verify') {
   const target = adapter.verify;
   if (!Array.isArray(target)) throw refuse('A complete internal verification target is missing.');
   await ensureChromium(project.root, store, signal);
   await store.run('Verifying application', target[0], target[1], { cwd: project.root, signal, env: { ...process.env, RER_LOCAL_OPERATION: operation.token } });
   await store.step('Serving the production build as rer deploy hosts it');
   const declaration = adapter.deployDeclaration ?? adapter.deploy?.declaration;
   const hosted = await (await import('./hosted-output.mjs')).checkHostedOutput(project.root, { declaration });
   await store.step('Checking that page sections hydrate as separate units');
   return { hosted, hydration: await (await import('./hydration/check.mjs')).checkHydration(project.root, { pages: adapter.publicPages, declaration, report: lines => lines.forEach(line => store.report(line)) }) };
  }
  if (['export', 'import'].includes(options.verb)) return await transfer(project, options, signal, { store, operationToken: operation.token });
  if (options.verb === 'deploy') {
   if (typeof adapter.deploy !== 'function') throw refuse('Owner-account deploy declaration is missing.');
   const link = async (origin, appSetupToken) => linkDependencies({project,input:project.setupSeed?await savedSetupAnswers(project,project.setupSeed.model):undefined,origin,store,signal,appSetupToken});
   return await (await import('./deploy-command.mjs')).deployCommand({ adapter, root: project.root, options, store, signal, operationToken: operation.token, localOnlyKeys: adapter.localOnlyKeys ?? [], checkBuild: () => refuseDevLayerOutput(project.root, adapter.devIdentity), setupManifest: project.setupManifest, setupSeed: project.setupSeed, linkDependencies: link });
  }
  const devKey = adapter.devIdentity && options.verb === 'setup' ? await ensureDevKey(project.root) : null;
  if (devKey) store.addSecrets?.([devKey]);
  let app;
  if (options.verb === 'setup') { proxy = await runtimeFrontDoor({ ...selected, devKey: devKey ?? undefined, origin: selected.url }); if (selected.door) await announceDoorRoute(selected, proxy); }
  const { appFetch } = await shared('app-fetch.mjs');
  const emailKey = localSettingKeys(project).email;
  const privateSettings = [...adapter.settings, '.rer/local/models.json', ...(project.privateInputs??[])];
  const run = () => adapter.run(project.root, input ?? { [emailKey]: options.ownerEmail ?? selected?.vars[emailKey] }, store,
   child => { app = child; }, signal,
   { verb: options.verb, ownerKey: emailKey, selectedOrigin: selected?.url, runtimePort: proxy?.runtimePort, operationToken: operation?.token, dev: adapter.dev, privateSettings, devKey: devKey ?? undefined });
  // A production build never sees the checkout's local settings, whatever the seed's build runs.
  if (options.verb === 'build') await withoutLocalSettings(project.root, { settings: privateSettings, operationToken: operation?.token }, run);
  else await run();
  if (['setup', 'build'].includes(options.verb)) await refuseDevLayerOutput(project.root, adapter.devIdentity);
  if (options.verb === 'build') await refuseLocalEnvOutput(project.root, adapter.devIdentity?.output);
  const url = selected?.url;
  if (options.verb === 'setup') {
   // Only a connected provider leaves first setup open; a native claim with
   // every optional dependency unanswered has already closed it.
   const {connected}=await linkDependencies({project,input,origin:url,store,signal});
   if(connected.length) {
    const proof=await localCliSessionProof(project);
    store.addSecrets?.([proof]);
    const completed=await appFetch(url+'/auth/setup-complete',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','x-rer-local-cli':proof},body:'{}',signal});
    if(!completed.ok)throw missing('The dependency setup has not completed an owner claim.');
    await completed.body?.cancel();
   }
   await store.stop(app);
   await rememberSetupAnswers(project, input);
   const deployNeeds = await hostedNeeds(project);
   if (options.json) out.event('setup-ready', { url, setupUrl: url+'/setup', ...(deployNeeds.length ? { neededForDeploy: deployNeeds } : {}) });
   else {
    out.human(`RER_SETUP_READY ${url}`); out.human(`Next: rer dev opens ${url} signed in as the owner; first-run setup finishes at ${url}/setup.`);
    if (deployNeeds.length) out.human(['To host it on your own Cloudflare account later, rer deploy needs:', ...deployNeeds.map(item => `  - ${item}`), 'Set them in your environment or a private (mode 0600) file passed with --env-file, then check with rer deploy --dry-run.'].join('\n'));
   }
  } else if (options.verb !== 'build') throw refuse('The requested first-party capability is unavailable.');
  return {};
 } catch (error) {
  failed = true;
  if (error instanceof RerError) throw error;
  throw await lifecycleError(error, store);
 } finally {
  // Every closer runs: one that fails must not leave the job-queue policy socket
  // listening (the process would never exit) or the local operation held, and
  // must not turn a finished command into a failure or hide the real one.
  const unclosed = [];
  for (const close of [() => store?.closeCommands(), () => proxy?.close(), () => operation?.release()]) {
   try { await close(); } catch (error) { unclosed.push(store?.redact?.(String(error?.message)) ?? 'unknown cause'); }
  }
  if (unclosed.length && !failed) out.progress(`Local cleanup could not confirm that every helper process stopped (${unclosed.join('; ')}). The ${options.verb} itself finished.\n`);
  // A failed independent command's diagnostic points here for its full output.
  if (temporary && !failed) await rm(temporary, { recursive: true, force: true });
  for (const [name, handler] of handlers) process.removeListener(name, handler);
  if (termination) throw new RerError('cancelled', `Stopped by ${termination} after owned children were stopped.`, termination === 'SIGINT' ? 130 : 143);
 }
}

// An explicit rer setup lists what hosting this checkout will need; the setup
// a zero-setup rer dev runs does not. The list is advice: it never fails setup.
async function hostedNeeds(project) {
 if (process.env[localDefaultsVariable] === '1') return [];
 try { return await (await import('./deploy-command.mjs')).hostedDeployNeeds(project); } catch { return []; }
}

// A failed install step names itself: its command, exit code, last output and
// full log. A step that stopped outside a command still names the step and log.
async function installStepError(error, store, root) {
 const { approvedFailure } = await shared('failures.mjs');
 // A step the job queue never admitted is a busy machine; its message already says what to do.
 if (approvedFailure(error)?.code === 'machine_busy') return error;
 const { checkoutPath, stepDiagnostic, stepFailureText } = await shared('step-failure.mjs');
 const step = approvedFailure(error)?.step ?? stepDiagnostic({ name: store.state.step, output: store.state.logs, log: store.redact(checkoutPath(root, store.logPath)) });
 // Only a RerError's message or a symbolic error code is safe to show; a native message can hold private data.
 const cause = error instanceof RerError ? `\n${error.message}` : /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? `\nCause: ${error.code}` : '';
 return new RerError(error instanceof RerError ? error.code : 'install_step_failed', `${stepFailureText(step)}${cause}`, error instanceof RerError ? error.exitCode : 1, { step, ...(Number.isInteger(step.exitCode) ? { childExitCode: step.exitCode, signal: step.signal } : {}) });
}

// Under the local operation, before the app starts: the zero-setup owner's
// row and saved owner setting become the real owner's, and one line says so.
async function replaceOwner(project, options, out) {
 const { from, to } = project.ownerReplacement, { replaceLocalOwner } = await shared('local/owner.mjs');
 await replaceLocalOwner(project.root, from, to, message => refuse(message));
 const secrets = project.adapter.hooks?.secrets, key = localSettingKeys(project).email;
 if (secrets) {
  const { readSettings, replaceSavedSetting } = await shared('adapter-settings.mjs');
  if ((await readSettings(project.root, secrets)).values[key]?.toLowerCase() === from.toLowerCase()) await replaceSavedSetting(project.root, secrets, key, to);
 }
 if (options.json) out.event('owner-replaced', { from, to });
 else out.human(`Replacing the zero-setup local owner ${from} with ${to}. Local data is kept.`);
}

// One plain line saying which port this checkout uses, and what moved.
function announcePort(out, options, selected) {
 if (selected.door) { if (options.json) out.event('origin', { url: selected.url, door: true }); else out.human(`Using ${selected.url} for this checkout, served through the front door.`); return; }
 const { moved, skipped } = selected;
 const line = moved ? `Moving this checkout from port ${moved.from} to port ${moved.to}. Its data is kept.`
  : !selected.savedOrigin ? `Using port ${selected.port} for this checkout${skipped ? ` (${skipped} is in use)` : ''}.` : undefined;
 if (!line) return;
 if (options.json) out.event('port', { port: selected.port, ...(moved ? { movedFrom: moved.from } : {}) });
 else out.human(line);
}
