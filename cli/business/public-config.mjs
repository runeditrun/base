import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { contained } from '../project.mjs';
import { shared } from '../shared.mjs';
import { originUrl, identifier } from './api.mjs';

export const trustKey = 'RER_BUSINESS_TRUST';
export const publicConfigPath = '.rer/business-runtime.json';
export const membershipPath = '.rer/business.json';

// Reconstruct the public part: never persist an audit email, private JWK, or
// any of the signed document, logo bytes or team returned by the platform.
export function publicTrust(value) {
 if (value?.v !== 1 || typeof value.issuer !== 'string' || value.audience !== 'self-host' || typeof value.subject !== 'string'
  || !/^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+$/.test(value.subject)
  || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw Error('Invalid Business public trust.');
 const keys = {};
 for (const [kid, key] of Object.entries(value.keys)) {
  identifier(kid);
  if (key?.kty !== 'EC' || key.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y) || key.d !== undefined) throw Error('Invalid Business public key.');
  keys[kid] = { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
 }
 if (!Object.keys(keys).length || Object.keys(keys).length > 16) throw Error('Invalid Business public keys.');
 return { v: 1, issuer: originUrl(value.issuer), audience: 'self-host', subject: value.subject, keys };
}

export async function readPublicJson(root, path) {
 const { readPrivateFile } = await shared('private-files.mjs');
 try { return JSON.parse(await readPrivateFile(await contained(root, path, { optional: true }))); }
 catch (error) { if (error.code === 'ENOENT') return null; throw Error('Business checkout configuration could not be read. Run rer business sync again.'); }
}

// The single reader used by both local runtime projection and deploy inputs.
export async function publicRuntimeConfig(root) {
 const config = await readPublicJson(root, publicConfigPath);
 return config ? { [trustKey]: JSON.stringify(publicTrust(config[trustKey])) } : {};
}

export async function writePublicJson(root, path, value) {
 const { privateDirectory, writePrivateFile } = await shared('private-files.mjs');
 await privateDirectory(root, ['.rer']);
 await writePrivateFile(await contained(root, path, { optional: true }), JSON.stringify(value) + '\n');
}

export async function removePublicJson(root, path) {
 await unlink(await contained(root, path, { optional: true })).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
