import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProject } from '../project.mjs';
import { selectedOrigin } from '../local.mjs';
import { heldDeployments } from '../deployment-record.mjs';
import { originUrl } from './api.mjs';

export async function checkout(root) {
 const project = await resolveProject(root);
 let edition;
 try { edition = JSON.parse(await readFile(join(root, 'edition.json'), 'utf8')).id; }
 catch (error) { if (error.code !== 'ENOENT') throw Error('The checkout edition.json could not be read.'); }
 const seed = edition ?? project.descriptor.project;
 if (typeof seed !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(seed)) throw Error('This checkout does not declare its edition.');
 return { project, seed };
}

export function sameSeed(remote, local) {
 // The catalogue uses a slug; edition manifests use publisher/slug.
 return remote === local || remote === local.split('/').at(-1);
}

export async function appOrigins(project) {
 const origins = [];
 const local = await selectedOrigin(project, {});
 if (local.savedOrigin) origins.push(local.url);
 const deployed = await heldDeployments(project.root);
 const production = deployed.find(item => item.environment === 'production');
 if (production?.record.receipt?.origin) origins.push(originUrl(production.record.receipt.origin));
 return [...new Set(origins)];
}
