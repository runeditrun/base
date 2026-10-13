// The npm registry's view of @runeditrun/rer: which versions exist, which is
// latest, and each one's tarball and integrity. The registry is
// npm_config_registry when set (npm sets it for npx), else the public one.
import { packageName } from '../package-info.mjs';

export const registryUrl = (env = process.env) => (env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');

export class UpdateFailure extends Error {}

export async function packageMetadata({ env = process.env, signal } = {}) {
 const url = `${registryUrl(env)}/${packageName.replace('/', '%2f')}`;
 let response;
 try { response = await fetch(url, { headers: { accept: 'application/json' }, signal }); }
 catch (error) { if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error; throw new UpdateFailure(`Could not reach ${registryUrl(env)} (${error.cause?.code ?? error.message}).`); }
 if (!response.ok) throw new UpdateFailure(`${url} answered ${response.status}${response.status === 404 ? ': @runeditrun/rer is not published there' : ''}.`);
 try { return await response.json(); } catch { throw new UpdateFailure(`${url} did not answer with package metadata.`); }
}

// The release to install: the exact version asked for, else latest.
export function pickRelease(metadata, wanted) {
 const version = wanted ?? metadata['dist-tags']?.latest, release = metadata.versions?.[version];
 if (!release) throw new UpdateFailure(wanted ? `Version ${wanted} of ${packageName} is not published.` : `The registry names no latest version of ${packageName}.`);
 return release;
}

// Semantic version order, prereleases below their release:
// 0.1.0-dev.gaa9b4d4f < 0.1.0 < 0.1.1-dev.g12345678 < 0.1.1.
export function compareVersions(a, b) {
 const parse = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
  if (!match) throw new UpdateFailure(`Not a version: ${version}`);
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
 };
 const x = parse(a), y = parse(b);
 for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
 if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
 for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
  const p = x.pre[i], q = y.pre[i];
  if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
  if (p === q) continue;
  const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
  if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
  if (pn !== qn) return pn ? -1 : 1;
  return p < q ? -1 : 1;
 }
 return 0;
}
