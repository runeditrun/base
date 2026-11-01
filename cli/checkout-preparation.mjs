// Read-only setup facts shared by the launcher, list and portable Business carry.
// Vendored commands cannot import global/launch, so these rules live with the CLI.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serversDirectory } from './server-registry.mjs';
import { exactVersion } from './package-mode.mjs';
import { shared } from './shared.mjs';

async function readJson(path) {
 try { return JSON.parse(await readFile(path, 'utf8')); }
 catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
}
async function mtime(path) { try { return (await stat(path)).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }

export function launchPath(checkout, env = process.env) {
 const name = basename(checkout).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'checkout';
 return join(serversDirectory(env), 'launches', `${name}-${createHash('sha256').update(checkout).digest('hex').slice(0, 12)}`);
}

// A checkout is set up when its pin's describe says so (`local.prepared`, from
// rer-cli-2); for older pins, when its primary private settings file holds
// anything. The pin's describe names it (`local.settings`, where the pin has it).
export async function hasSettings(root, described) {
 if (typeof described?.local?.prepared === 'boolean') return described.local.prepared;
 const primary = described?.local?.settings?.[0] ?? '.dev.vars';
 try { return (await stat(join(root, primary))).size > 0; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Every pin's setup saves its answers file only once it has finished, so a
// file newer than this launcher's record of its own attempt (its start for
// 'running', its end for 'failed') is a setup that finished after it.
async function finishedSince(root, described, at) {
 const saved = await mtime(join(root, described?.local?.installerState ?? '.seed/installer', 'setup-answers.json'));
 return saved !== undefined && typeof at === 'number' && saved > at;
}

// Setup runs on a checkout with no saved settings ('fresh'). When a setup this
// launcher started did not finish ('running' after a kill, or 'failed') and no
// setup has finished since, it runs again ('resume') and keeps what the earlier
// attempt saved. A checkout set up any other way is never set up again.
// A checkout that is not prepared but already holds an owner (a setting a newer
// manifest added is missing) resumes too, so the saved owner and origin are
// kept; one without a saved owner gets the local owner ('fresh').
export async function setupNeeded(root, described, last) {
 if (!await hasSettings(root, described)) return described?.local?.ownerSaved === true ? 'resume' : 'fresh';
 if (!last || last.state === 'done') return undefined;
 return await finishedSince(root, described, last.at) ? undefined : 'resume';
}

const bundledEntry = fileURLToPath(new URL('../bin/rer.mjs', import.meta.url));
async function pinnedEntry(checkout) {
 const manifest = await readJson(join(checkout, 'package.json')).catch(() => null);
 const declared = manifest?.devDependencies?.['@runeditrun/rer'] ?? manifest?.dependencies?.['@runeditrun/rer'];
 const installed = declared && (await readJson(join(checkout, 'node_modules/@runeditrun/rer/package.json')).catch(() => null))?.version;
 if (declared && !(installed && (installed === declared || !exactVersion.test(declared)))) return null;
 if (declared) return join(checkout, 'node_modules/@runeditrun/rer/bin/rer.mjs');
 const vendored = join(checkout, 'scripts/rer.mjs');
 return await stat(vendored).then(info => info.isFile()).catch(() => false) ? vendored : bundledEntry;
}

export async function checkoutPreparation(checkout, env = process.env) {
 let describing = true;
 try {
  const entry = await pinnedEntry(checkout);
  if (!entry) return { prepared: false, reason: 'the pinned rer package is not installed: run rer install' };
  const { stdout } = await promisify(execFile)(process.execPath, [entry, 'describe', '--json'], { cwd: checkout, env, maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  const described = JSON.parse(stdout);
  describing = false;
  const last = await readJson(join(launchPath(checkout, env), 'setup.json'));
  const needed = await setupNeeded(checkout, described, last);
  return { prepared: !needed, ...(needed ? { reason: 'the checkout is not set up yet: run rer setup' } : {}) };
 } catch (error) {
  const { createRedaction, credentialValues } = await shared('redaction.mjs');
  const redaction = createRedaction();
  redaction.addSecrets(credentialValues(env));
  const cause = error.stderr?.trim() || (describing ? `rer describe failed in ${checkout}.` : error.message);
  return { prepared: null, reason: `rer describe fails here: ${redaction.redact(cause.split('\n')[0])}` };
 }
}
