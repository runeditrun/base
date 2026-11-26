import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labels } from './adapter-labels.mjs';
import { credentialValues } from './redaction.mjs';
import { privateDirectory, readPrivateFile, writePrivateFile } from './private-files.mjs';
import { localVariables } from './local/environment.mjs';
import { assertRegular, inspect } from './local/files.mjs';
import { localOperation } from './local/operation.mjs';
import { recoverInterrupted } from './local/recovery.mjs';
// The shared loopback predicate, beside this copy in Base or in a seed's scripts/.
const portable = basename(dirname(fileURLToPath(import.meta.url))) === 'base-onboarding';
const { isLoopbackHost } = await import(new URL(portable ? '../base-cli/modules/operator-auth/loopback.mjs' : '../modules/operator-auth/loopback.mjs', import.meta.url));

async function freePort(host = '127.0.0.1') {
 const socket = createServer();
 await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, host === 'localhost' ? '127.0.0.1' : host, resolve); });
 const { port } = socket.address();
 await new Promise(resolve => socket.close(resolve));
 return port;
}

// A rerun keeps the loopback origin already saved in the seed's settings (a
// 127.0.0.1, localhost or [::1] port, or a front-door `NAME.localhost` origin),
// so sessions, links and the owner's bookmarks stay valid. A fresh install
// binds the host the seed declares (commandAdapter({ host }); the installer
// server puts it on the store beside the setup manifest).
async function chooseOrigin(context, hooks) {
 if (context.selectedOrigin) return context.selectedOrigin;
 if (typeof hooks.origin === 'function') return hooks.origin(context);
 const key = hooks.secrets?.originKey;
 if (key) {
  const saved = (await readSettings(context.root, hooks.secrets)).values[key];
  try { const url = new URL(saved); if (url.protocol === 'http:' && isLoopbackHost(url.hostname) && url.port && url.origin === saved) return saved; } catch {}
 }
 const host = context.store?.host ?? '127.0.0.1';
 if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`The seed adapter declares host ${JSON.stringify(String(host)).slice(0, 80)}; it must be exactly 127.0.0.1, localhost or ::1.`);
 return `http://${host === '::1' ? '[::1]' : host}:${await freePort(host)}`;
}

async function readSettings(root, { file = '.dev.vars', format = 'dotenv' }) {
 const path = resolve(root, file);
 const within = relative(root, path);
 if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('Installer settings must stay inside the checkout.');
 await privateDirectory(root, within.split(sep).slice(0, -1));
 const status = await inspect(path);
 assertRegular(status);
 if (!status) return { path, values: {}, text: undefined };
 const text = await readPrivateFile(path);
 if (format === 'json') {
  let values;
  try { values = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON; restore it before installing.`); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${file} must hold a JSON object.`);
  return { path, values, text };
 }
 return { path, values: localVariables(text), text };
}

const dotenvValue = value => /^[A-Za-z0-9._@:/+=,-]*$/.test(value) ? value : JSON.stringify(value);

// Each changed setting is rewritten on its own line and each new one appended,
// so every other line of the private settings keeps its bytes.
function dotenvText(text = '', updates, file = '.dev.vars') {
 const saved = localVariables(text), added = [];
 let result = text;
 for (const [key, value] of Object.entries(updates)) {
  const line = `${key}=${dotenvValue(value)}`;
  if (Object.hasOwn(saved, key)) result = result.replace(new RegExp(`^${key}=.*$`, 'm'), () => line); else added.push(line);
 }
 if (added.length) result = result.replace(/\n*$/, '\n').replace(/^\n$/, '') + added.join('\n') + '\n';
 const parsed = localVariables(result);
 for (const [key, value] of Object.entries(updates)) if (parsed[key] !== value) throw new Error(`Could not change ${key} in ${file}; put ${key}=VALUE on its own line, then retry.`);
 return result;
}

// A kept settings file gains only the managed generated secrets a newer
// manifest declares and the file lacks (an install from before them). Saved
// values and bytes are untouched, and an owner-visible token the owner removed
// stays removed. A file is kept only when it holds an earlier setup's owner
// (`context.ownerKey`, where the caller names it); one that holds only other
// keys gains this setup's settings beside them.
async function keepSettings(current, { manifest, store }, { format = 'dotenv' }) {
 const added = Object.fromEntries((manifest?.fields ?? []).filter(field => field.kind === 'secret' && field.input === 'managed' && field.generate && !Object.hasOwn(current.values, field.name))
  .map(field => [field.name, randomBytes(32).toString(field.generate)]));
 if (!Object.keys(added).length) return current.values;
 store.addSecrets?.(Object.values(added));
 const merged = { ...current.values, ...added };
 await writePrivateFile(current.path, format === 'json' ? JSON.stringify(merged, null, 1) + '\n' : dotenvText(current.text, added));
 return merged;
}

// Generate and store private settings. Approved public/entered answers win;
// existing generated values and untouched rerun bytes are preserved. Credential
// values are registered for redaction before any later command can print them.
// The file is owner-only (0600); both formats are written under the local
// operation lock after interrupted builds are recovered.
async function writeSecrets(context, options) {
 const { root, store } = context;
 const { generate = [], encoding = 'hex', values, format = 'dotenv' } = options;
 await store.step(labels.secrets);
 {
  const current = await readSettings(root, options);
  if (options.keepExisting && current.text !== undefined && (!context.ownerKey || current.values[context.ownerKey])) { store.addSecrets?.(credentialValues(current.values, context.manifest?.fields.filter(field => field.kind === 'secret').map(field => field.name))); return keepSettings(current, context, options); }
  const wanted = { ...(typeof values === 'function' ? await values(context) : values ?? {}) };
  const manifest=context.manifest;
  const generated=manifest?manifest.fields.filter(field=>field.kind==='secret'&&field.generate):generate.map(name=>({name,generate:encoding}));
  if(manifest){
   for(const field of manifest.fields)if(typeof context.input[field.name]==='string')wanted[field.name]=context.input[field.name];
  }
  for (const field of generated)if(!Object.hasOwn(current.values,field.name))wanted[field.name] = randomBytes(32).toString(field.generate);
  for(const field of manifest?.fields??[])if(field.kind==='secret'&&field.input!=='entered'&&!field.generate&&(field.required||field.presentations?.some(item=>item.required))&&!(current.values[field.name]||wanted[field.name]))throw Error(`Required supplied secret ${field.name} is missing.`);
  const approved = new Set((manifest?.fields ?? []).filter(field => field.kind !== 'secret' || field.input === 'entered').map(field => field.name));
  const updates = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => typeof value === 'string' &&
   (!Object.hasOwn(current.values, key) || (approved.has(key) && current.values[key] !== value))));
  for (const [key, value] of Object.entries(updates)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new TypeError(`Unsupported local setting ${key}.`);
  store.addSecrets?.((manifest?.fields??[]).filter(field=>field.kind==='secret').flatMap(field=>[current.values[field.name],wanted[field.name]]).filter(Boolean));
  const merged = { ...current.values, ...updates };
  store.addSecrets?.([...generated.map(field => merged[field.name]).filter(Boolean), ...(manifest?.fields??[]).filter(field=>field.kind==='secret').map(field=>merged[field.name]).filter(Boolean), ...credentialValues(merged)]);
  if (Object.keys(updates).length) await writePrivateFile(current.path, format === 'json' ? JSON.stringify(merged, null, 1) + '\n' : dotenvText(current.text, updates, options.file));
  return merged;
 }
}

// Setup on another port or loopback host moves the checkout: the saved origin
// changes here, and settings derived from it change with setup's answers.
// The key is the one the CLI reads (the declared originKey, else AUTH_ORIGIN).
async function moveSavedOrigin(context, options, values) {
 const key = options.originKey ?? 'AUTH_ORIGIN', origin = context.selectedOrigin;
 if (!origin || values[key] === undefined || values[key] === origin) return values;
 return rewriteOrigin(context.root, options, values, origin);
}

// Rewrite only the saved origin (rer dev --door and --direct). The caller holds
// the local operation lock.
export async function replaceSavedOrigin(root, options, origin) {
 return rewriteOrigin(root, options, (await readSettings(root, options)).values, origin);
}

// Rewrite only one saved setting (setup replacing the zero-setup owner). The
// caller holds the local operation lock.
export async function replaceSavedSetting(root, options, key, value) {
 return rewriteSetting(root, options, (await readSettings(root, options)).values, key, value);
}

function rewriteOrigin(root, options, values, origin) {
 return rewriteSetting(root, options, values, options.originKey ?? 'AUTH_ORIGIN', origin);
}

async function rewriteSetting(root, options, values, key, value) {
 const current = await readSettings(root, options), merged = { ...values, [key]: value };
 await writePrivateFile(current.path, (options.format ?? 'dotenv') === 'json' ? JSON.stringify(merged, null, 1) + '\n' : dotenvText(current.text, { [key]: value }, options.file));
 return merged;
}

// Select the origin only after recovery, under the same lock as publication.
export async function prepareSettings(context, hooks) {
 const operation = context.operationToken ? await localOperation(context.root, context.operationToken) : await recoverInterrupted(context.root) ?? await localOperation(context.root);
 try {
  context.origin = await chooseOrigin(context, hooks);
  context.vars = await moveSavedOrigin(context, hooks.secrets, await writeSecrets(context, hooks.secrets));
  await hooks.secrets.afterWrite?.(context);
 } finally { await operation.release(); }
}

export { freePort, chooseOrigin, readSettings };
