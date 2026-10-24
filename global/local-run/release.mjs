// Local release identity comes from Git custody, never a server-supplied URL.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { loadAnchors, verifyRelease, compareVersion, LIMITS } from '../../modules/release/signature.mjs';
import { ownManifest } from '../package-info.mjs';
import { update } from '../update/command.mjs';
import { git, run, text } from './process.mjs';
import { failure } from './error.mjs';
import { readRecord } from './upstream-record.mjs';

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const IDENTITY = /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d._-]{1,100}$/i;
const refuse = code => { throw failure(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function githubRepository(origin) {
 if (typeof origin !== 'string' || origin !== origin.trim()) refuse('refused');
 const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/?#]+\/[^/?#]+)$/.exec(origin);
 if (!match) refuse('refused');
 return repositoryIdentity(match[1].replace(/\.git$/, ''));
}

function repositoryIdentity(value) {
 if (typeof value !== 'string' || !IDENTITY.test(value) || value.split('/').some(part => ['.', '..'].includes(part))) refuse('refused');
 return value.toLowerCase();
}

async function originRepository(checkout) {
 try {
  const urls = (await text(checkout, ['config', '--get-all', 'remote.origin.url'])).split('\n');
  if (urls.length !== 1) refuse('refused');
  return githubRepository(urls[0]);
 } catch { refuse('refused'); }
}

async function readBytes(path, limit) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > limit) refuse('release_unverified');
  const buffer = Buffer.alloc(stat.size + 1);
  let length = 0;
  while (length < buffer.length) {
   const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
   if (!bytesRead) break;
   length += bytesRead;
  }
  if (length !== stat.size) refuse('release_unverified');
  return buffer.subarray(0, length);
 } finally { await file.close(); }
}

async function descends(checkout, ancestor, descendant, code) {
 const result = await git(checkout, ['merge-base', '--is-ancestor', ancestor, descendant], { allow: [1, 128] });
 if (result.code !== 0) refuse(code);
}

export async function recordedRelease(checkout) {
 const selected = await readRecord(checkout);
 if (!selected) refuse('release_not_found');
 const repository = await originRepository(checkout);
 if (repositoryIdentity(selected.repository) !== repository) throw failure('refused', 'rer-upstream.json names a different repository.');
 await descends(checkout, selected.commit, 'HEAD', 'refused');
 return { ...selected, repository };
}

async function github(checkout, endpoint, { asset = false } = {}) {
 try {
  const args = ['api', endpoint];
  if (asset) args.push('-H', 'Accept:application/octet-stream');
  const result = await run('gh', args, {
   cwd: checkout, timeout: 30000, maxBuffer: asset ? LIMITS.envelopeBytes : 1024 * 1024,
   env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
  });
  return asset ? Buffer.from(result.stdout) : JSON.parse(result.stdout);
 } catch { refuse(asset ? 'release_unverified' : 'release_not_found'); }
}

async function tagForCommit(checkout, commit) {
 let refs;
 try { refs = await text(checkout, ['ls-remote', '--tags', 'origin'], { timeout: 30000, maxBuffer: 1024 * 1024 }); }
 catch { refuse('release_not_found'); }
 const direct = new Map(), peeled = new Map();
 for (const line of refs.split('\n').filter(Boolean)) {
  const match = /^([a-f0-9]{40})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
  if (!match) refuse('release_not_found');
  (match[3] ? peeled : direct).set(match[2], match[1]);
 }
 const tags = [...direct.keys()].filter(tag => TAG.test(tag) && (peeled.get(tag) ?? direct.get(tag)) === commit);
 if (tags.length !== 1) refuse('release_not_found');
 return tags[0];
}

async function minimumVersion(checkout, commit) {
 const result = await git(checkout, ['show', `${commit}:RELEASE.json`], { allow: [128], maxBuffer: 4 * 1024 * 1024 });
 if (result.code !== 0) return undefined;
 let release;
 try { release = JSON.parse(result.stdout); } catch { refuse('release_unverified'); }
 if (!object(release)) refuse('release_unverified');
 const minimum = release.min_rer_version;
 if (minimum !== undefined && (typeof minimum !== 'string' || !VERSION.test(minimum))) refuse('release_unverified');
 return minimum;
}

export async function ensureRerVersion(minimum) {
 if (minimum === undefined) return;
 try {
  const version = () => ownManifest().version.split('-')[0];
  if (compareVersion(minimum, version()) <= 0) return;
  if (await update([]) !== 0 || compareVersion(minimum, version()) > 0) refuse('rer_update_required');
 } catch { refuse('rer_update_required'); }
}

export async function resolveRelease({ checkout, repository: supplied, to, anchors, fresh = false } = {}) {
 try {
  const repository = await originRepository(checkout);
  if (supplied !== undefined && repositoryIdentity(supplied) !== repository) refuse('refused');
  // Publisher main can record a newer release than the requested initial one.
  // Only existing installations have an owner baseline to enforce here.
  let base;
  try { if (!fresh) base = await recordedRelease(checkout); }
  catch (error) { if (error.error_code !== 'release_not_found') throw error; }
  let tag;
  if (to !== undefined) {
   if (typeof to !== 'string' || (!TAG.test(to) && !SHA.test(to))) refuse('release_not_found');
   tag = SHA.test(to) ? await tagForCommit(checkout, to) : to;
  }
  const release = await github(checkout, `repos/${repository}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : 'latest'}`);
  if (!object(release) || release.draft !== false || release.prerelease !== false || !TAG.test(release.tag_name)
    || (tag && release.tag_name !== tag)) refuse('release_not_found');
  tag = release.tag_name;
  try { await git(checkout, ['fetch', '--no-tags', 'origin', `refs/tags/${tag}`], { timeout: 60000, maxBuffer: 1024 * 1024 }); }
  catch { refuse('release_not_found'); }
  const [commit, tree, tagObject] = await Promise.all([
   text(checkout, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']),
   text(checkout, ['rev-parse', '--verify', 'FETCH_HEAD^{tree}']),
   text(checkout, ['rev-parse', '--verify', 'FETCH_HEAD']),
  ]);
  if (![commit, tree, tagObject].every(value => SHA.test(value)) || (SHA.test(to ?? '') && commit !== to)) refuse('release_unverified');
  if (!Array.isArray(release.assets)) refuse('release_unverified');
  const assets = release.assets.filter(asset => asset?.name === 'rer-release.dsse.json');
  if (assets.length !== 1 || !Number.isSafeInteger(assets[0].id) || assets[0].id <= 0
    || !Number.isSafeInteger(assets[0].size) || assets[0].size <= 0 || assets[0].size > LIMITS.envelopeBytes) refuse('release_unverified');
  const envelope = await github(checkout, `repos/${repository}/releases/assets/${assets[0].id}`, { asset: true });
  const anchorBytes = await readBytes(anchors ?? new URL('../../modules/release/anchors/production.json', import.meta.url), 4 * 1024 * 1024);
  const environment = anchors === undefined ? 'production' : JSON.parse(anchorBytes).environment;
  const trusted = await loadAnchors(anchorBytes, environment);
  const verified = await verifyRelease(envelope, trusted, { environment, expect: {
   repository: `https://github.com/${repository}`, tag, publicCommit: commit, publicTree: tree, tagObject,
  } });
  if (verified.verdict !== 'VERIFIED') refuse('release_unverified');
  if (base) await descends(checkout, base.commit, commit, 'release_unverified');
  const minimum = await minimumVersion(checkout, commit);
  await ensureRerVersion(minimum);
  return { repository, tag, commit, verified_at: new Date().toISOString(), ...(minimum === undefined ? {} : { min_rer_version: minimum }) };
 } catch (error) {
  if (error.error_code) throw error;
  refuse('release_unverified');
 }
}
