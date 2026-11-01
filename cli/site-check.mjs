import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { privateDataScanner, decodedText } from './site-data.mjs';
import { javascriptContent, javascriptContext } from './site-references.mjs';
import { javascriptStrings } from './site-syntax.mjs';
import { markupReferences, markupStrings, htmlElements, cssStrings } from './site-markup.mjs';
import { refuse, RerError } from './errors.mjs';
import { DEV_AI_MARKER, DEV_LAYER_MARKER } from './dev-identity.mjs';

// What a run site may hold: static pages and the files they use, served as
// Cloudflare static assets with default HTML handling. Never server code,
// Wrangler configuration, migrations, settings, local data or owner data.
const FORBIDDEN = /^(?:wrangler\.(?:json|jsonc|toml)|_worker\.js|_routes\.json|_headers|_redirects|.*\.(?:sql|rer|db|sqlite|sqlite3|env|map))$/i;
// Routes that exist only on an installed instance.
export const INSTANCE_ROUTES = ['/signin', '/sign-in', '/login', '/setup', '/app', '/auth', '/api', '/__dev', '/health', '/.well-known'];
const MAX_FILE = 25 * 1024 * 1024, MAX_FILES = 20000;

/** Every file, as a site path ("run.html") with its bytes. */
async function files(folder) {
 const found = new Map();
 async function walk(directory, prefix) {
  for (const name of (await readdir(directory)).sort()) {
   const path = join(directory, name), site = prefix + name, status = await lstat(path);
   if (name.startsWith('.')) throw refuse(`The run site holds a hidden file: ${site}. It contains only public pages and their files.`);
   if (status.isSymbolicLink() || (!status.isFile() && !status.isDirectory())) throw refuse(`The run site holds a link or special file: ${site}.`);
   if (status.isDirectory()) { await walk(path, site + '/'); continue; }
   if (FORBIDDEN.test(name)) throw refuse(`The run site holds ${site}, which is not a static page or asset. Server code, configuration, migrations and data never go in it.`);
   if (status.size > MAX_FILE) throw refuse(`The run site file ${site} is larger than 25 MiB.`);
   found.set(site, await readFile(path));
   if (found.size > MAX_FILES) throw refuse('The run site holds more than 20,000 files.');
  }
 }
 await walk(folder, '');
 return found;
}

const safeDecode = path => { try { return decodeURI(path); } catch { return path; } };

export function identityPattern(value) {
 const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const word = '[\\p{L}\\p{M}\\p{N}_]', mailbox = value.includes('@');
 const left = mailbox ? "[\\p{L}\\p{M}\\p{N}_.!#$%&'*+/=?^`{|}~@-]" : word;
 const right = mailbox ? '[\\p{L}\\p{M}\\p{N}_@-]|\\.[\\p{L}\\p{M}\\p{N}_-]' : word;
 // Paired prose quotes delimit the whole mailbox. An apostrophe inside a
 // longer local part (prefix'owner@example.test) must keep its old boundary.
 const quoted = mailbox ? `|(?<!\\\\)'${escaped}'` : '';
 return {mailbox, pattern:new RegExp(`(?<!${left})(?:${escaped}(?!${right})${quoted})`,mailbox ? 'iu' : 'u')};
}

/** How Cloudflare's static assets (auto-trailing-slash) answer a path, or null. */
export function servedFile(names, pathname) {
 const path = pathname.replace(/^\/+/, '');
 if (!path) return names.has('index.html') ? 'index.html' : null;
 if (names.has(path) && !path.endsWith('.html')) return path;
 const bare = path.replace(/\/$/, '');
 if (names.has(`${bare}.html`)) return `${bare}.html`;
 if (names.has(`${bare}/index.html`)) return `${bare}/index.html`;
 return null;
}

/**
 * Refuse a run site folder that is not exactly static pages and the files they
 * use: an index and a Run page, every same-origin link resolving, no link to an
 * instance-only route, nothing fetched from another origin, no dev layer, and
 * none of the given private values (owner identity, secrets, the dev key).
 */
export async function checkSite(folder, { privateValues = [], privateIdentities = [], root } = {}) {
 const all = await files(folder), names = new Set(all.keys());
 if (!names.has('index.html')) throw refuse('The run site has no index.html (its homepage).');
 if (!servedFile(names, '/run')) throw refuse('The run site has no /run page.');
 const markers = [DEV_LAYER_MARKER, DEV_AI_MARKER].map(value => Buffer.from(value));
 const containsPrivateData = privateDataScanner(privateValues, privateIdentities);
 let parse;
 if (root) {
  const require = createRequire(join(root, 'package.json'));
  ({parseAst:parse} = await import(pathToFileURL(require.resolve('vite')).href));
 }
 const documents = [], treesByFile = new Map();
 for (const [site, bytes] of all) {
  const text = bytes.toString('utf8'), trees = /\.[cm]?js$/.test(site) && parse ? [parse(text)] : [];
  if (/\.(?:html|svg)$/.test(site)) {
   documents.push(text);
   for (const {tag, attributes, content} of htmlElements(text)) {
    if (tag === 'script' && !attributes.has('src') && parse && /^(?:|module|(?:text|application)\/(?:java|ecma)script)$/i.test(attributes.get('type') ?? '')) trees.push(parse(content));
   }
  }
  treesByFile.set(site, trees);
 }
 const context = javascriptContext(documents, [...treesByFile.values()].flat());
 const problems = [], unresolved = [];
 for (const [site, bytes] of all) {
  if (markers.some(marker => bytes.includes(marker))) throw refuse(`The run site file ${site} contains the local-only dev layer.`);
  const html = /\.(?:html|svg)$/.test(site), css = site.endsWith('.css'), js = /\.[cm]?js$/.test(site);
  const text = bytes.toString('utf8'), trees = treesByFile.get(site), literals = css ? cssStrings(text) : html ? markupStrings(text) : [];
  const scripts = trees.map(tree => javascriptContent(tree, context)), strings = trees.flatMap(javascriptStrings);
  if (containsPrivateData(bytes, [...literals, ...strings, ...strings.flatMap(markupStrings), ...scripts.flatMap(script => script.literals)])) throw new RerError('site_private_data', `The run site file ${site} contains this installation's private data (owner identity or a secret). The run site renders only edition identity.`, 4);
  if (!html && !css && !js) continue;
  const refs = [...(js ? [] : markupReferences(text, html)), ...scripts.flatMap(script => script.references)];
  for (const script of scripts) for (const {kind} of script.unresolved) unresolved.push({asset:site, kind});
  for (const reference of refs) {
   const url = decodedText(reference.url), {navigates} = reference;
   if (!url || /^(?:#|mailto:|tel:|data:|javascript:void)/i.test(url)) continue;
   if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    if (!navigates) problems.push(`${site} fetches ${url} from another origin`);
    continue;
   }
   const pathPrefix = safeDecode(url.replace(/[?#].*$/, ''));
   const pathname = posix.resolve(reference.documentRelative ? '/' : '/' + posix.dirname(site), pathPrefix);
   // An unfinished `/api` could become `/apiculture`; a slash, query or
   // fragment already fixes the instance path even when its tail is runtime.
   const boundary = !reference.dynamic || /[?#]/.test(url) || pathPrefix.endsWith('/');
   if (INSTANCE_ROUTES.some(route => (pathname === route && boundary) || pathname.startsWith(route + '/'))) problems.push(`${site} links to ${pathname}, which exists only on an installed instance`);
   else if (!reference.dynamic && !servedFile(names, safeDecode(pathname))) problems.push(`${site} links to ${pathname}, which the site does not have`);
  }
 }
 if (problems.length) throw refuse(`The run site has broken or out-of-site references: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}.`);
 return { files: names.size, pages: [...names].filter(name => name.endsWith('.html')).length, references:{unresolved} };
}
