import { createInterface } from 'node:readline/promises';
import { readPublicJson, publicConfigPath, membershipPath, publicTrust, trustKey } from './public-config.mjs';

// Trust is authoritative for older joined checkouts whose membership predates
// the businessId field. A missing membership must not permit a silent switch.
export async function checkoutConnection(root) {
 const membership = await readPublicJson(root, membershipPath);
 const config = await readPublicJson(root, publicConfigPath);
 const trust = config ? publicTrust(config[trustKey]) : null;
 return { membership, trust };
}

export async function confirmConnection(connection, state, app, { replace = false } = {}) {
 const { membership, trust } = connection;
 const subject = `${state.businessId}/${app}`;
 const different = trust && (trust.issuer !== state.origin || trust.subject !== subject)
  || membership && (membership.app !== app || membership.businessId && membership.businessId !== state.businessId
   || membership.issuer && membership.issuer !== state.origin);
 if (!different) return;
 const refuse = () => Object.assign(Error('This checkout is connected to another Business app. To switch, run rer business sync --replace in a terminal and confirm.'), { code: 'business_checkout_connected' });
 if (!replace || !process.stdin.isTTY || !process.stderr.isTTY) throw refuse();
 const prompt = createInterface({ input: process.stdin, output: process.stderr });
 try {
  if (await prompt.question('Replace this checkout’s Business connection? Type yes: ') !== 'yes') throw refuse();
 } finally { prompt.close(); }
}
