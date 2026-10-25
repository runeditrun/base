#!/usr/bin/env node
// Child of `rer build --site` and `rer dev`: builds the seed's declared site
// entry with the checkout's own Vite for Node (an SSR build), loads it and
// calls its sitePages({ styles }), then writes the static run site: "/" to
// index.html, "/run" to run.html, "/docs/a" to docs/a.html, "/404" to
// 404.html, the declared public files, and the stylesheet and files the
// entry's CSS imports compile to. The optional site config is a Vite config
// naming the plugins the site pages need (a docs virtual module, a CSS
// toolchain); the app's own Vite config is never loaded, because its Worker
// plugins do not run in Node. It reads no installation data. A seed with a
// CONTRACT.md gets it parsed as sitePages({ contract }), for its /contract
// page; one that does not parse stops the build, naming its lines. `hosting`
// (cli/site-hosting.mjs) is what its /docs/hosting page says.
// Usage: node site-render.mjs ROOT ENTRY OUTPUT [CONFIG]
import { shared } from './shared.mjs';
const { seedIcons, readIconFiles } = await shared('icon-files.mjs');
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildClients, writeSiteAsset } from './site-client.mjs';
import { htmlElements } from './site-markup.mjs';
import { searchCorpus } from './site-runtime.mjs';
import { redactSiteOutput, siteBuildDiagnostic } from './site-diagnostics.mjs';
import { ContractError, parseContract } from '../foundation/runtime/seed-contract.mjs';

redactSiteOutput();

const [root, entry, output, config, clientJSON] = process.argv.slice(2);
const fail = message => { process.stderr.write(`${message}\n`); process.exit(2); };
if (!root || !entry || !output) fail('Usage: site-render.mjs ROOT ENTRY OUTPUT [CONFIG]');
const inside = (base, path) => { const target = resolve(base, path); return target === base || target.startsWith(base + sep) ? target : null; };
// Compiled CSS and the files it references land under this folder of the site.
const ASSETS = 'site-assets';

let vite;
try { vite = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('vite')).href); }
catch { fail('The run site renders with the checkout\'s own Vite. Run rer install first.'); }
process.env.NODE_ENV ??= 'production';

let contract;
try { contract = parseContract(await readFile(join(root, 'CONTRACT.md'), 'utf8')); }
catch (error) {
 if (error instanceof ContractError) fail(`The run site's /contract page is built from CONTRACT.md, which does not parse:\n${error.message}`);
 if (error.code !== 'ENOENT') throw error;
}

// The Node bundle sits beside the output, inside the checkout, so its external
// imports resolve from the checkout's node_modules. It never enters the site.
const server = `${output}.render`;
let module, styles = [], files = [];
try {
 const built = await vite.build({
  plugins: [seedIcons()],
  root, configFile: config ? resolve(root, config) : false, envFile: false, logLevel: 'error', mode: 'production',
  build: {
   ssr: resolve(root, entry), outDir: server, emptyOutDir: true, copyPublicDir: false, ssrEmitAssets: true,
   cssCodeSplit: false, assetsDir: ASSETS, sourcemap: false, minify: false, reportCompressedSize: false, watch: null,
  },
 }).catch(error => fail(`The run site entry ${entry} did not build: ${siteBuildDiagnostic(error)}${config ? '' : '\nIf its pages need Vite plugins (a docs virtual module, a CSS toolchain), name a site Vite config: site: { config } in the command adapter.'}`));
 const outputs = (Array.isArray(built) ? built : [built]).flatMap(result => result.output ?? []);
 const chunk = outputs.find(item => item.type === 'chunk' && item.isEntry);
 if (!chunk) fail(`The run site entry ${entry} produced no module.`);
 files = outputs.filter(item => item.type === 'asset' && item.fileName.startsWith(`${ASSETS}/`)).map(item => item.fileName);
 styles = files.filter(name => name.endsWith('.css')).map(name => `/${name}`);
 await writeFile(join(server, 'package.json'), '{"type":"module"}\n');
 module = await import(pathToFileURL(join(server, chunk.fileName)).href);
 if (typeof module.sitePages !== 'function') fail(`${entry} must export sitePages(), returning { pages: [{ path, html }], assets: [public paths] }.`);
 const options = clientJSON ? JSON.parse(clientJSON) : {};
 const clientBuild = await buildClients(vite, root, output, options), clients = clientBuild.clients;
 styles = [...new Set([...styles,...clientBuild.styles])];
 const build = await module.sitePages({ styles, clients, ...(contract ? { contract } : {}), hosting: options.hosting ?? null });
 if (!Array.isArray(build?.pages) || !Array.isArray(build.assets)) fail('sitePages() returns { pages, assets }.');

 // Build metadata stays beside the assets, never in the public asset upload.
 await writeFile(`${output}.redirects.json`, JSON.stringify(build.redirects === undefined ? [] : build.redirects));
 const written = new Set();
 for (const page of build.pages) {
  if (typeof page?.path !== 'string' || !/^\/(?:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)?$/i.test(page.path) || page.path.endsWith('.html') || typeof page.html !== 'string') fail(`Invalid site page ${JSON.stringify(page?.path)}: a path such as /run with its HTML.`);
  const file = page.path === '/' ? 'index.html' : `${page.path.slice(1)}.html`;
  if (written.has(file) || file.startsWith(`${ASSETS}/`)) fail(`Duplicate site page ${page.path}.`);
  written.add(file);
  await mkdir(dirname(join(output, file)), { recursive: true });
  await writeFile(join(output, file), page.html);
 }
 if (options.runtime) {
  const pages = build.pages.map(page => ({...page, ids:new Set(htmlElements(page.html).map(element=>element.attributes.get('id')).filter(Boolean))}));
  await writeFile(options.corpus, JSON.stringify(searchCorpus(pages, build.searchPages)));
 }
 const publicDirectory = resolve(root, 'public');
 for (const asset of build.assets) {
  const source = typeof asset === 'string' && !asset.split('/').some(part => !part || part.startsWith('.')) && inside(publicDirectory, asset);
  if (!source || source === publicDirectory) fail(`Invalid site asset ${JSON.stringify(asset)}: a file or folder under public/.`);
  if (asset === ASSETS || asset.startsWith(`${ASSETS}/`)) fail(`public/${ASSETS} is reserved for the run site's compiled styles; rename it.`);
  await lstat(source).catch(() => fail(`Missing site asset public/${asset}.`));
  await cp(source, join(output, asset), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
 }
 const icons = await readIconFiles(publicDirectory);
 // A custom site entry may not use Base's head. Export selected icons only
 // when a generated page actually links them, like its other public assets.
 const linkedIcons = new Set(build.pages.flatMap(({ html }) => htmlElements(html)
  .filter(({ tag, attributes }) => tag === 'link' && (attributes.get('rel') ?? '').toLowerCase().split(/\s+/).some(rel => ['icon', 'apple-touch-icon'].includes(rel)))
  .map(({ attributes }) => attributes.get('href')?.split(/[?#]/)[0])));
 for (const [path, { bytes }] of icons.files) {
  if (!linkedIcons.has(path)) continue;
  const target = join(output, path.slice(1));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
 }
 // Only the emitted files: the Node chunks share the folder and never ship.
 for (const file of files) {
  await writeSiteAsset(output,file,await readFile(join(server,file)));
 }
 process.stdout.write(`${JSON.stringify({ pages: build.pages.length, assets: build.assets.length, styles: styles.length })}\n`);
} finally { await rm(server, { recursive: true, force: true }); }
// Vite and the loaded pages can keep handles open; every file is written.
process.exit(0);
