import { heldDeployments } from './deployment-record.mjs';
import { invalid } from './errors.mjs';

// rer export reads only this computer's copy. A hosted address (--origin, or
// --target remote) names the hosted install, which rer cannot export yet: the
// portability export writes snapshot tables into the database it reads, so it
// never runs against a live hosted one. Refuse before any effect rather than
// save the local copy under the hosted install's name.
export async function refuseHostedExport(project, options) {
 if (options.origin === undefined && options.target !== 'remote') return;
 if (project.adapter?.portability?.remote === true) return;
 const origin = options.origin === undefined ? undefined : new URL(options.origin).origin;
 const held = await heldDeployments(project.root);
 const matched = held.filter(({ record }) => origin !== undefined && record.receipt?.origin === origin);
 const named = (matched.length ? matched : held).map(({ record }) => ({ databases: Object.keys(record.owned?.d1 ?? {}), buckets: Object.keys(record.owned?.r2 ?? {}) }));
 const databases = named.flatMap(item => item.databases), buckets = named.flatMap(item => item.buckets);
 const exports = (databases.length ? databases : ['DATABASE']).map(name => `  npx wrangler d1 export ${name} --remote --output exports/${name === 'DATABASE' ? 'hosted' : name}.sql`);
 throw invalid([
  `This exports the local copy. rer cannot export the hosted install${origin ? ` at ${origin}` : ''} yet, so nothing was exported. Keep the hosted install until you have saved its data.`,
  `To export the hosted install's database, run this from this checkout with the Cloudflare credentials that deployed it (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment, or add --env-file FILE):`,
  ...exports,
  ...(databases.length ? [] : ['  (npx wrangler d1 list names the hosted databases.)']),
  ...(buckets.length ? [`Files the hosted install keeps in R2 (${buckets.join(', ')}) are not in that export.`] : []),
  'To export the local copy, run: rer export --output exports/local.rer',
 ].join('\n'));
}
