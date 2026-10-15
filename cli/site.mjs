import { readFile, rename, rm, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contained } from './project.mjs';
import { invalid, missing, refuse, RerError } from './errors.mjs';
import { checkSite } from './site-check.mjs';
import { readDevKey } from './dev-identity.mjs';
import { shared } from './shared.mjs';
import { unpublishedIdentities } from './site-private.mjs';
import { privateSitePaths } from './site-inputs.mjs';
import { redactSiteText } from './site-diagnostics.mjs';

// The run site: a seed's static marketing pages, /run and docs, built from
// edition identity with no installation data. A seed opts in with
// commandAdapter's `site: { entry, output, declaration, config? }`: the module
// whose sitePages({ styles }) returns the pages, the ignored folder the build
// writes, the deploy declaration naming the run site's domain, and optionally
// the Vite config holding the plugins the site pages need.
const relativePath = value => typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');

export function declaredSite(project) {
 const site = project.adapter?.site;
 if (!site) throw refuse('This checkout declares no run site. A seed opts in with site: { entry, output, declaration } in its command adapter; see SEED-COMMAND-CONTRACT.md.');
 if (!relativePath(site.entry) || !relativePath(site.output) || !relativePath(site.declaration) || (site.config !== undefined && !relativePath(site.config)) || (site.clientConfig !== undefined && !relativePath(site.clientConfig)) || ['src', 'public', 'node_modules', 'migrations'].some(top => site.output === top || site.output.startsWith(top + '/'))) throw invalid('The declared run site needs relative entries/configs, an output folder outside src, public and node_modules, and a deploy declaration.');
 if (site.clients !== undefined && (!site.clients || Array.isArray(site.clients) || typeof site.clients !== 'object' || Object.entries(site.clients).some(([name, entry]) => !/^[a-z][a-z0-9-]*$/i.test(name) || !relativePath(entry)))) throw invalid('Run site clients is a map of island names to relative client entry paths.');
 return site;
}

// Owner identity, secrets and the dev key: none may appear in the run site.
async function privateValues(project) {
 const privateValues = [], privateIdentities = [], names = project.adapter.input?.names ?? {};
 const { localVariables } = await shared('local/environment.mjs');
 const manifest = await readFile(join(project.root, project.adapter.setup?.manifestFile ?? 'rer-setup.json'), 'utf8').then(JSON.parse, () => ({}));
 const secretNames = new Set((manifest.fields ?? []).filter(field => field.kind === 'secret').map(field => field.name));
 const variables = await readFile(join(project.root, project.adapter.hooks?.secrets?.file ?? '.dev.vars'), 'utf8').then(localVariables, () => ({}));
 for (const [key, value] of Object.entries(variables)) {
  if ([names.email, names.name].includes(key)) privateIdentities.push(value);
  else if (secretNames.has(key) || /SECRET|TOKEN|PASSWORD|_KEY$/.test(key)) privateValues.push(value);
 }
 const answers = await readFile(join(project.root, '.seed/installer/setup-answers.json'), 'utf8').then(JSON.parse, () => ({}));
 for (const [key, value] of Object.entries(answers)) if (secretNames.has(key) || /SECRET|TOKEN|PASSWORD|_KEY$/.test(key)) privateValues.push(value);
 for (const key of [names.email, names.name]) if (typeof answers?.[key] === 'string') privateIdentities.push(answers[key]);
 const key = await readDevKey(project.root).catch(() => null);
 if (key) privateValues.push(key);
 return { privateValues, privateIdentities: await unpublishedIdentities(project.root, privateIdentities, privateSitePaths(project.adapter)) };
}

/** Render the run site into its declared folder, check it and replace the previous build. */
export async function buildSite(project, store, signal) {
 const site = declaredSite(project);
 await contained(project.root, site.entry);
 if (site.config) await contained(project.root, site.config);
 if (site.clientConfig) await contained(project.root, site.clientConfig);
 for (const entry of Object.values(site.clients ?? {})) await contained(project.root, entry);
 const folder = await contained(project.root, site.output, { optional: true });
 await mkdir(dirname(folder), { recursive: true });
 const staging = `${folder}.building-${process.pid}`;
 await rm(staging, { recursive: true, force: true });
 try {
  await mkdir(staging);
  try { await store.run('Building the run site', process.execPath, [fileURLToPath(new URL('./site-render.mjs', import.meta.url)), project.root, site.entry, staging, site.config ?? '', JSON.stringify({entries:site.clients ?? {}, config:site.clientConfig, privatePaths:privateSitePaths(project.adapter)})], { cwd: project.root, signal, heavy: false }); }
  catch (error) {
   const code = await readFile(`${staging}.refusal`, 'utf8').catch(() => '');
   if (code === 'site_private_input') throw new RerError(code, 'Run site client imports a private installation file or a file outside the seed and its declared dependencies.', 4);
   if (code === 'site_client_server_import') throw new RerError(code, 'Run site client imports a server-only module. Use browser dependencies in every reachable island module.', 4);
   // Command capture appends its absolute log path after the child output.
   const { approvedFailure, commandFailure } = await shared('failures.mjs');
   const diagnostic = approvedFailure(error);
   if (diagnostic) throw commandFailure(redactSiteText(diagnostic.message), diagnostic);
   throw error;
  }
  const checked = await checkSite(staging, {root:project.root, ...await privateValues(project)});
  await rm(folder, { recursive: true, force: true });
  await rename(staging, folder);
  return { folder, ...checked };
 } finally { await Promise.all([staging, `${staging}.render`, `${staging}.refusal`].map(path => rm(path, { recursive: true, force: true }))); }
}

async function siteDeployment(project, options, folder) {
 const site = declaredSite(project), environment = options.environment ?? 'production';
 const read = async path => { try { return JSON.parse(await readFile(await contained(project.root, path), 'utf8')); } catch (error) { if (error instanceof RerError) throw error; throw invalid(`Malformed ${path}.`); } };
 const app = await read(project.adapter.deploy?.declaration ?? 'deploy.json'), declaration = await read(site.declaration);
 const { sitePlan } = await import('../modules/deploy-kit/site.mjs');
 try { return sitePlan({ project: app.project, environment, compatibilityDate: app.compatibilityDate, declaration, assets: folder }); }
 catch (error) { throw invalid(`The run site deploy declaration is invalid (${error.message}). ${site.declaration} holds {"version": 1, "domain": "<apex hostname>"}.`); }
}

/** `rer build --site` and `rer deploy --site [--dry-run]`. */
export async function siteCommand(project, options, store, signal, out) {
 const built = await buildSite(project, store, signal);
 if (!options.json && built.references.unresolved.length) {
  out.human(`Run site references: ${built.references.unresolved.length} runtime resource target(s) could not be resolved statically:`);
  for (const {asset, kind} of built.references.unresolved) out.human(`  ${asset}: ${kind}`);
 }
 if (options.verb === 'build') {
  // Output redaction masks an inherited PWD (a credential-shaped name), so the
  // checkout-relative folder is named too.
  const path = relative(project.root, built.folder);
  if (!options.json) out.human(`Run site written to ${path} (${built.pages} pages, ${built.files} files): ${built.folder}`);
  return { site: { folder: built.folder, path, pages: built.pages, files: built.files, references:built.references } };
 }
 const plan = await siteDeployment(project, options, built.folder);
 const human = [`Run site plan: site Worker ${plan.worker}, Base-generated, its only binding the assets (the app's Worker ${plan.appWorker} is not touched)`, `  assets: ${plan.assets} (${built.files} files; HTML ${plan.assetsConfig.html_handling}, not found ${plan.assetsConfig.not_found_handling}; the Worker runs first)`,
  `  custom domains: ${plan.hostnames.join(', ')}; workers.dev off`, ...plan.redirects.map(rule => `  redirect in the Worker: ${rule.from} -> ${rule.to} (${rule.status}, keeps ${rule.keeps.join(' and ')})`)];
 const summary = { worker: plan.worker, appWorker: plan.appWorker, module: plan.module, bindings: plan.bindings, assets: plan.assets, files: built.files, references:built.references, domain: plan.domain, hostnames: plan.hostnames, workersDev: false, runWorkerFirst: true, assetsConfig: plan.assetsConfig, redirects: plan.redirects.map(({ from, to, status }) => ({ from, to, status })) };
 if (options.dryRun) {
  if (options.json) out.event('site', summary); else for (const line of human) out.human(line);
  store.report('deploy --site: dry run complete; no deployment occurred and no provider request was made.');
  return { dryRun: true, deployed: false, site: summary };
 }
 const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
 if (names.some(name => !process.env[name]?.trim())) throw missing('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required, with the run site token permissions in the deploy-kit README.');
 if (!options.json) for (const line of human) out.human(line);
 const { cloudflare } = await import('../modules/deploy-kit/provider.mjs');
 const { collectFiles } = await import('../modules/deploy-kit/artifact.mjs');
 const { siteDeploy, siteReadbackSummary } = await import('../modules/deploy-kit/site.mjs');
 const environment = options.environment ?? 'production';
 try {
  const api = cloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
  // The receipt is for the person; ownership is read from the provider, so a fresh checkout deploys too.
  const result = await siteDeploy({ api, plan, files: await collectFiles(built.folder), receiptPath: join(project.root, '.rer', 'deploy', `site-${environment}.json`) });
  return { dryRun: false, deployed: true, origin: result.origin, site: summary };
 } catch (error) {
  if (error instanceof RerError) throw error;
  throw new RerError('deploy_refused', `Run site deploy stopped: ${/^[a-z0-9-]{1,80}$/.test(error.message) ? error.message : 'site-deploy-failed'}${error.resource ? ` (${error.resource})` : ''}.${siteReadbackSummary(error)}`, 1);
 }
}

/** For rer dev: build the run site and serve it on the first free port above the app's. */
export async function devSite(project, store, signal, { host, port }) {
 const built = await buildSite(project, store, signal);
 const { sitePreview } = await import('./site-preview.mjs');
 return { ...await sitePreview(built.folder, { host, ports: Array.from({ length: 50 }, (_, index) => port + 1 + index).filter(value => value <= 65535) }), folder: relative(project.root, built.folder) };
}

