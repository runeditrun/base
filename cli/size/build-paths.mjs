// Where a build lives when size-check.json does not say: the Vite Cloudflare build's wrangler file (its main,
// migrations and assets are read relative to that file's folder) and the deploy declaration.
export const defaultBuild = { wrangler: 'dist/server/wrangler.json', deployDeclaration: 'deploy.json' };
