// Credentialed child only of a real `rer deploy --site`. Its progress is
// captured by the command store, preserving the public CLI's JSON protocol.
import { buildSearchArtifacts } from '../modules/site/docs-search/artifacts.mjs';
const [corpus, assets, output, endpoint, compatibilityDate, domain] = process.argv.slice(2);
await buildSearchArtifacts({ corpus, assets, output, endpoint, compatibilityDate,
 previousUrl: `https://${domain}/docs-search-vectors.json` }, { accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
