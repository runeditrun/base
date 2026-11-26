// The Business that issued a Worker's relay sender, kept beside rer's deploy records. A held key from another
// Business is not a dead one: rer reads this to leave it alone when the computer is connected elsewhere now.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { shared } from './shared.mjs';

const pointer = environment => join('.rer', 'deploy', `${environment}.mail.json`);

export async function rememberMailBusiness(root, environment, businessId) {
 const { privateDirectory, writePrivateFile } = await shared('private-files.mjs');
 await privateDirectory(root, ['.rer', 'deploy']);
 await writePrivateFile(join(root, pointer(environment)), JSON.stringify({ businessId }) + '\n');
}

// The issuing Business id, or undefined for a sender issued before this record existed (or an unreadable record).
export async function mailBusiness(root, environment) {
 try { const { businessId } = JSON.parse(await readFile(join(root, pointer(environment)), 'utf8')); return typeof businessId === 'string' && businessId ? businessId : undefined; }
 catch { return undefined; }
}

export const forgetMailBusiness = (root, environment) => rm(join(root, pointer(environment)), { force: true });
