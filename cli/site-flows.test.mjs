import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { exportReference } from '../scripts/export-reference.mjs';
import { createRequire } from 'node:module';
import { sitePreview } from './site-preview.mjs';
import { codeChipBreaksWord, commandBlocks, runLayoutTheme } from './fixtures/run-page.mjs';
import { headerLayout, splitCardLayout } from './fixtures/contract-page.mjs';
import { parseContract } from '../foundation/runtime/seed-contract.mjs';
import { deployPermissions } from './deploy-needs.mjs';
const {chromium} = createRequire(resolve(import.meta.dirname,'../default-seed/package.json'))('@playwright/test');

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');
async function seed(t) {
 const directory = await mkdtemp(join(tmpdir(), 'rer-site-flow-')), root = join(directory, 'seed');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await mkdir(join(directory, 'home'));
 await exportReference(base, root);
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 const adapter = join(root, 'scripts/installer/local.mjs'), original = await readFile(adapter, 'utf8');
 const pages = join(root, 'src/site/pages.ts');
 const render = (html, runHtml = '<p>Run</p>') => writeFile(pages, `export function sitePages({ clients = {}, styles = [] }) { return { pages: [{path:'/',html:styles.map(url=>'<link rel="stylesheet" href="'+url+'">').join('')+${JSON.stringify(html)}.replace('CLIENT_URL', clients.demo ?? '')}, {path:'/run',html:${JSON.stringify(runHtml)}}], assets: [] }; }`);
 const build = async (env = {}) => {
  try { const result = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'build', '--site', '--json', '--no-queue'], { cwd: root, env: { PATH:process.env.PATH, HOME:join(directory, 'home'), TZ:'UTC', CI: 'true', RER_NO_UPDATE_CHECK: '1', ...env }, maxBuffer: 1024 * 1024 }); return {code:0, ...result}; }
  catch (error) { return {code:error.code, stdout:error.stdout, stderr:error.stderr}; }
 };
 return { root, adapter, original, pages, render, build };
}

test('site dry-run names the usable checkout-relative asset destination in human and JSON output', async t => {
 const f = await seed(t);
 for (const json of [false, true]) {
  const result = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'deploy', '--site', '--dry-run', ...(json ? ['--json'] : [])], {
   cwd: f.root, env: { PATH: process.env.PATH, HOME: resolve(f.root, '../home'), PWD: f.root, TZ: 'UTC', RER_NO_UPDATE_CHECK: '1' },
  });
  const assets = json ? JSON.parse(result.stdout.trim().split('\n').at(-1)).site.assets : /assets: (.*?) \(/.exec(result.stdout)?.[1];
  assert.ok(assets, result.stdout);
  assert.equal(isAbsolute(assets), false);
  assert.ok(!assets.includes('[REDACTED]'), 'the destination remains readable after redaction');
  assert.ok((await stat(resolve(f.root, assets))).isDirectory(), 'the printed destination identifies the built assets');
  assert.ok(!(result.stdout + result.stderr).includes(f.root), 'shared dry-run output keeps the checkout path private');
 }
});

test('built run-site uses US dates and keeps the one-line command start together', async t => {
 const f = await seed(t);
 await writeFile(join(f.root, 'CONTRACT.md'), (await readFile(join(base, 'foundation/template/CONTRACT.md'), 'utf8')).replaceAll('BASE_COMMIT', '0123abcd').replaceAll('BASE_DATE', '2026-10-18'));
 const runData = join(f.root, 'src/site/run.ts');
 await writeFile(runData, (await readFile(runData, 'utf8')).replaceAll('runeditrun/base', 'just-every/run-buoy').replaceAll('Default seed', 'Chest').replace('docs: false', 'docs: true'));
 const identity = join(f.root, 'src/core/app/identity.ts'), theme = join(f.root, 'public/rer-theme.css');
 await writeFile(identity, (await readFile(identity, 'utf8')).replace("product: 'Default seed'", "product: 'Chest'"));
 await writeFile(theme, await readFile(theme, 'utf8') + runLayoutTheme);
 // A seed with docs and no install article serves Base's moved-page helper.
 await writeFile(f.pages, (await readFile(f.pages, 'utf8')).replace('import { runPageHtml,', 'import { docsMovedHtml, runPageHtml,').replace('pages: [', "pages: [{ path: '/docs', html: '<!doctype html><title>Docs</title><h1>Documentation</h1>' }, { path: '/docs/getting-started', html: '<!doctype html><title>Getting started</title><h1>Getting started</h1>' }, { path: '/docs/install', html: docsMovedHtml(identity, run, '/docs/getting-started', 'Getting started') },"));
 await writeFile(join(f.root, 'public/favicon.svg'), await readFile(join(f.root, 'public/brand/mark.svg')));
 const result = await f.build({TZ:'America/Los_Angeles'});
 assert.equal(result.code, 0, result.stdout + result.stderr);
 const preview = await sitePreview(join(f.root, 'dist/site'), {ports:[0]}), browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 try {
  const context = await browser.newContext({viewport:{width:390,height:844},timezoneId:'America/Los_Angeles',permissions:['clipboard-read','clipboard-write']}), page = await context.newPage();
  await page.goto(preview.url + '/contract');
  const contractDate = { text:await page.locator('time').textContent(), datetime:await page.locator('time').getAttribute('datetime'), dataDate:await page.locator('#progress').getAttribute('data-date') };
  const moved = await context.request.get(preview.url + '/docs/install');
  assert.equal(moved.status(), 200);
  const movedHtml = await moved.text();
  assert.match(movedHtml, /http-equiv="refresh"/);
  assert.match(movedHtml, /rel="canonical" href="\/docs\/getting-started"/);
  await page.goto(preview.url + '/docs/install');
  await page.waitForURL(preview.url + '/docs/getting-started');
  await page.goto(preview.url + '/run');
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(await page.locator('link[rel=icon], link[rel=apple-touch-icon]').evaluateAll(links => links.map(link => ({ href: link.getAttribute('href'), sizes: link.getAttribute('sizes') }))), [{ href: '/favicon.svg', sizes: 'any' }], 'the built shared head selects the existing small icon instead of the full mark');
  assert.equal((await context.request.get(preview.url + '/favicon.svg')).status(), 200, 'the selected icon is exported with the site');
  assert.ok(await page.locator('p code').count(), 'the built page has inline commands');
  const commandStartLines = () => page.locator('.alt code').evaluate(code => {
   const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT), tops = new Set();
   let offset = 0;
   for (let node = walker.nextNode(); node; node = walker.nextNode()) for (let i = 0; i < node.length; i++, offset++) {
    if (offset >= 'npx -y @runeditrun/rer dev'.length || /\s/.test(node.textContent[i])) continue;
    const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
    tops.add(Math.round(range.getBoundingClientRect().top));
   }
   return tops.size;
  });
  assert.deepEqual({ ...contractDate, commandStartLines:await commandStartLines() }, { text:'Oct 18, 2026', datetime:'2026-10-18', dataDate:'2026-10-18', commandStartLines:1 }, 'US date and unbroken one-line command start at 390px');
  const widths = new Set([390]);
  for (let width = 360; width <= 2560; width += 20) widths.add(width);
  for (let width = 361; width <= 399; width++) widths.add(width);
  for (let width = 770; width <= 810; width++) widths.add(width);
  for (const width of [...widths].sort((a, b) => a - b)) {
   await page.setViewportSize({width,height:900});
   assert.equal(await commandStartLines(), 1, `one-line command start at ${width}px`);
   assert.deepEqual(await codeChipBreaksWord(page), [], `inline code at ${width}px`);
   assert.deepEqual((await commandBlocks(page)).filter(block => block.covered || block.clipped), [], `command blocks at ${width}px`);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5), false, `sideways overflow at ${width}px`);
  }
  for (const code of await page.locator('p code').all()) {
   const text = await code.textContent();
   await code.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('copy'); });
   assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, 'selecting inline code copies its exact text');
  }
  for (const button of await page.locator('.copy').all()) {
   const command = await button.getAttribute('data-copy');
   await button.click();
   await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, command);
   assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command, 'Copy keeps the command bytes');
  }
  // Exercise the same built run site with both kinds populated, using the
  // existing full contract fixture rather than a hand-built card fragment.
  const slate = await readFile(join(base, 'foundation/fixtures/slate-contract-e60b107.md'), 'utf8');
  // Expand a "see the clause" gap to that clause's own full text, exercising
  // long-form gaps without inventing a second contract or changing its status.
  const long = parseContract(slate).clauses.find(clause => clause.id === 'COLLAB-001');
  await writeFile(join(f.root, 'CONTRACT.md'), slate.replace(/^(\| `COLLAB-001`[^\n]*?)\| see the clause \|/m, (_, row) => `${row}| ${long.text.replace(/\s+/g, ' ').replaceAll('|', '\\|')} |`));
  const contractBuild = await f.build();
  assert.equal(contractBuild.code, 0, contractBuild.stdout + contractBuild.stderr);
  await page.reload();
  await page.getByRole('navigation', {name:'Site', exact:true}).getByRole('link', {name:'Roadmap', exact:true}).click();
  await page.evaluate(() => document.fonts.ready);
  const rendered = await page.locator('body').textContent();
  assert.doesNotMatch(rendered, /\b[0-9a-f]{7,40}\b|\b(?:src|tests)\/|\b[\w./-]+\.(?:ts|mjs|sql)\b/i);
  assert.equal(await page.locator('[data-commit], a[href*="/commit/"]').count(), 0);
  const disclosure = page.locator('details.gap').first();
  assert.ok(await disclosure.count(), 'long product gaps are disclosed on request');
  await disclosure.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.getAttribute('open'), '');
  assert.ok(await disclosure.locator('p').isVisible());
  await page.keyboard.press('Space');
  assert.equal(await disclosure.getAttribute('open'), null);
  assert.equal(await page.locator('.card.split > div').count(), 2, 'both clause kinds are visible');
  for (const width of [860, 1000, 1160]) {
   await page.setViewportSize({width,height:900});
   const layout = await splitCardLayout(page);
   assert.deepEqual(layout.overlaps, [], `split-card text overlap at ${width}px`);
   assert.deepEqual(layout.overflow, [], `split-card text overflow at ${width}px`);
   assert.equal(layout.sideways, false, `split-card sideways overflow at ${width}px`);
   assert.equal(layout.pageSideways, false, `contract sideways overflow at ${width}px`);
  }
  // The header keeps its links on screen at the narrowest phone: Docs, Roadmap and Source beside a long name wrap below it.
  for (const path of ['/contract', '/run']) {
   await page.goto(preview.url + path);
   await page.setViewportSize({width:320,height:700});
   assert.deepEqual(await headerLayout(page), { sideways:false, links:3, offscreen:[], small:[], overlaps:[] }, `header at 320px on ${path}`);
  }
  await context.close();
 } finally { await browser.close(); await preview.close(); }
});

test('built run site writes /docs/hosting from the seed\'s own declarations, Run Edit Run first', async t => {
 const f = await seed(t);
 const runData = join(f.root, 'src/site/run.ts'), declaration = join(f.root, 'deploy.json');
 await writeFile(runData, (await readFile(runData, 'utf8')).replaceAll('runeditrun/base', 'just-every/run-buoy'));
 const declared = JSON.parse(await readFile(declaration, 'utf8'));
 let result = await f.build();
 assert.equal(result.code, 0, result.stdout + result.stderr);
 const preview = await sitePreview(join(f.root, 'dist/site'), {ports:[0]}), browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 try {
  const context = await browser.newContext({viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']}), page = await context.newPage();
  const hosting = async () => {
   await page.goto(preview.url + '/docs/hosting');
   return page.evaluate(() => ({
    sections: [...document.querySelectorAll('main > section')].map(section => section.getAttribute('aria-labelledby')),
    request: document.querySelector('.assisted a')?.href,
    token: document.querySelector('#token')?.closest('li')?.textContent ?? '',
    deployFile: [...document.querySelectorAll('.code pre code')].map(code => code.textContent).find(text => text.includes('CLOUDFLARE_API_TOKEN=')) ?? '',
   }));
  };
  const built = await hosting();
  assert.deepEqual(built.sections, ['assisted', 'diy'], 'Run Edit Run comes before the do-it-yourself steps');
  const request = new URL(built.request);
  assert.deepEqual([request.origin, request.searchParams.get('product'), request.searchParams.get('plan')], ['https://app.runeditrun.com', 'run-buoy', 'assisted']);
  for (const permission of deployPermissions(declared)) assert.ok(built.token.includes(permission), `the token step asks for ${permission}`);
  assert.equal(built.token.includes('R2 Storage'), false, 'nothing the declaration does not use');
  for (const width of [320, 390, 1440]) {
   await page.setViewportSize({width,height:900});
   assert.deepEqual((await commandBlocks(page)).filter(block => block.covered || block.clipped), [], `command blocks at ${width}px`);
   assert.deepEqual(await codeChipBreaksWord(page), [], `inline code at ${width}px`);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5), false, `sideways overflow at ${width}px`);
   assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())).map(element => parseFloat(getComputedStyle(element).fontSize)).filter(size => size < 13)), [], `text under 13px at ${width}px`);
  }
  for (const button of await page.locator('.copy').all()) {
   const command = await button.getAttribute('data-copy');
   assert.equal(command, await button.evaluate(element => element.closest('.code').querySelector('pre code').textContent), 'Copy holds the command shown');
   await button.click();
   await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, command);
  }
  // The page follows the declaration: an R2 binding adds its permission, and one rer deploy
  // refuses leaves Run Edit Run's help alone while the run site still builds.
  await writeFile(declaration, JSON.stringify({ ...declared, r2: [{ binding: 'FILES' }] }));
  result = await f.build();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok((await hosting()).token.includes('Workers R2 Storage: Edit'));
  await writeFile(declaration, JSON.stringify({ ...declared, platforms: ['cloudflare'] }));
  result = await f.build();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual((await hosting()).sections, ['assisted']);
  await context.close();
 } finally { await browser.close(); await preview.close(); }
});

test('site build distinguishes published examples from private identifiers and never exempts secrets', async t => {
 const f = await seed(t);
 await run('git', ['init', '-q'], { cwd:f.root });
 await writeFile(join(f.root, 'example.md'), 'Published example: example-owner@example.test\n');
 await run('git', ['add', 'example.md'], { cwd:f.root });
 await run('git', ['-c', 'user.name=Site Test', '-c', 'user.email=site-test@example.test', 'commit', '-qm', 'Public example source'], {cwd:f.root});
 await writeFile(join(f.root, '.dev.vars'), 'OWNER_EMAIL=example-owner@example.test\nSESSION_SECRET=test-only-private-secret-value\n');
 await f.render('<p>example-owner@example.test</p>');
 let result = await f.build();
 assert.equal(result.code, 0, result.stdout + result.stderr);
 await writeFile(join(f.root, '.dev.vars'), 'OWNER_EMAIL=private-owner@example.test\nSESSION_SECRET=test-only-private-secret-value\n');
 await f.render('<p>private-owner@example.test</p>');
 result = await f.build();
 assert.equal(result.code, 4, result.stdout + result.stderr);
 assert.match(result.stdout, /site_private_data/);
 // Even an untracked source containing the identifier is not a public example.
 await writeFile(join(f.root, 'untracked.md'), 'private-owner@example.test');
 assert.equal((await f.build()).code, 4);
 // A longer public address and a dirty tracked file cannot exempt this owner.
 await writeFile(join(f.root, 'example.md'), 'prefix.private-owner@example.test');
 await run('git', ['add','example.md'], {cwd:f.root});
 await writeFile(join(f.root, 'example.md'), 'private-owner@example.test');
 assert.equal((await f.build()).code,4);
 await writeFile(join(f.root, 'example.md'), 'test-only-private-secret-value');
 await run('git', ['add', 'example.md'], { cwd:f.root });
 await f.render('<p>test-only-private-secret-value</p>');
 assert.equal((await f.build()).code, 4);
});

test('site build bundles declared client islands and their imports for the browser', async t => {
 const f = await seed(t);
 await writeFile(f.adapter, f.original.replace("site: {", "site: { clients: { demo: 'src/site/demo.ts' },"));
 await writeFile(join(f.root,'src/site/demo.ts'), "import './island.css'; import {label} from './label'; document.querySelector('#demo')!.firstChild!.data = label; import('./later').then(m => m.ready());");
 await writeFile(join(f.root,'src/site/island.css'), '#demo{font-style:italic}');
 await writeFile(join(f.root,'src/site/label.ts'), "export const label = 'Island works';");
 await writeFile(join(f.root,'src/site/later.ts'), "export const ready = () => document.body.dataset.ready = 'yes';");
 await f.render('<body><main><h1>Public island</h1><a href="/run">Run</a><button type="button">Demo</button><p id="demo">Loading</p></main><script type="module" src="CLIENT_URL"></script></body>');
 const result = await f.build();
 assert.equal(result.code, 0, result.stdout + result.stderr);
 const home = await readFile(join(f.root,'dist/site/index.html'),'utf8'), source = /src="([^"]+)"/.exec(home)?.[1];
 assert.ok(source?.startsWith('/site-assets/'), 'page receives the emitted client URL');
 const preview = await sitePreview(join(f.root,'dist/site'), {ports:[0]}), browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 try {
  const page = await browser.newPage();
  await page.goto(preview.url);
  await page.waitForFunction(() => document.body.dataset.ready === 'yes');
  assert.equal(await page.locator('#demo').textContent(), 'Island works');
  assert.equal(await page.locator('#demo').evaluate(element=>getComputedStyle(element).fontStyle),'italic');
 } finally { await browser.close(); await preview.close(); }
});

test('site build scans encoded island secrets after path and alphanumeric prefixes', async t => {
 const f = await seed(t), secret = 'synthetic-private-value-\uffff';
 await writeFile(f.adapter, f.original.replace("site: {", "site: { clients: { demo: 'src/site/demo.ts' },"));
 await writeFile(join(f.root, '.dev.vars'), `SESSION_SECRET=${secret}\n`, {mode:0o600});
 await f.render('<script type="module" src="CLIENT_URL"></script>');
 const cases = [];
 for (const encoding of ['base64','base64url']) for (let offset = 0; offset < 4; offset++) {
  // The secret is inside the decoded payload, so matching its standalone
  // encoding alone cannot find every case.
  cases.push(`/asset/${'a'.repeat(offset)}${Buffer.from(`wrapped:${secret}:end`).toString(encoding)}`);
 }
 cases.push(`prefix${Buffer.from(secret).toString('base64').replace(/=+$/, '')}suffix`);
 for (const [index, value] of cases.entries()) await t.test(`encoded payload ${index + 1}`, async () => {
  await writeFile(join(f.root, 'src/site/demo.ts'), `document.body.textContent = ${JSON.stringify(value)};`);
  const result = await f.build();
  assert.equal(result.code, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /site_private_data/);
  await assert.rejects(readFile(join(f.root, 'dist/site/index.html')), {code:'ENOENT'});
 });
});

test('site build checks object data URLs and scans private text-node data', async t => {
 const f = await seed(t), secret = 'synthetic-text-private-value';
 await writeFile(f.adapter, f.original.replace("site: {", "site: { clients: { demo: 'src/site/demo.ts' },"));
 await writeFile(join(f.root, '.dev.vars'), `SESSION_SECRET=${secret}\n`, {mode:0o600});
 const textPage = '<p id="demo">Loading</p><object id="embed"></object><script type="module" src="CLIENT_URL"></script>';
 const objectPage = '<div id="demo"><object></object></div><script type="module" src="CLIENT_URL"></script>';
 const traversal = "document.querySelector('#demo').firstChild.data";
 const cases = [
  ...[
   ['https://outside.example.test/private', /from another origin/],
   ['/api/private', /only on an installed instance/],
   ['/missing-resource', /which the site does not have/],
  ].map(([target, error]) => ({ html:objectPage, source:`${traversal} = ${JSON.stringify(target)};`, error })),
  ...[
   "document.createElement('object').data",
   "document.querySelector('object#embed').data",
  ].map(target => ({ source:`${target} = 'https://outside.example.test/private';` })),
  { source:"document.querySelector('object').setAttribute('data', 'https://outside.example.test/private');" },
  { runHtml:'<div id="demo"><object></object></div>', source:`${traversal} = 'https://outside.example.test/private';` },
  { html:'<div id="demo"><object></object></div>' + textPage, source:`${traversal} = 'https://outside.example.test/private';` },
  { html:textPage.replace('<script type=', '<script>document.querySelector("#demo").replaceChildren(document.createElement("object"))</script><script type='), source:`${traversal} = 'https://outside.example.test/private';` },
 ];
 for (const { html = textPage, runHtml, source, error = /from another origin/ } of cases) {
  await f.render(html, runHtml);
  await writeFile(join(f.root, 'src/site/demo.ts'), source);
  const result = await f.build();
  assert.equal(result.code, 4, result.stdout + result.stderr);
  assert.match(result.stdout, error);
 }
 await f.render(textPage);
 await writeFile(join(f.root, 'src/site/demo.ts'), `document.querySelector('#demo').firstChild.data = ${JSON.stringify(secret)};`);
 const result = await f.build();
 assert.equal(result.code, 4, result.stdout + result.stderr);
 assert.match(result.stdout, /site_private_data/);
});


test('site build refuses private data reached by a browser island', async t => {
 const f = await seed(t);
 await writeFile(f.adapter, f.original.replace("site: {", "site: { clients: { demo: 'src/site/demo.ts' },"));
 await writeFile(join(f.root, '.dev.vars'), 'SESSION_SECRET=synthetic-island-private-value\n', {mode:0o600});
 await writeFile(join(f.root, 'src/site/demo.ts'), "import privateSettings from '../../.dev.vars?raw'; document.body.textContent = privateSettings;");
 await f.render('<script type="module" src="CLIENT_URL"></script>');
 const result = await f.build();
 assert.equal(result.code, 4, result.stdout + result.stderr);
 assert.match(result.stdout, /site_private_input/);
 await assert.rejects(readFile(join(f.root, 'dist/site/index.html')), {code:'ENOENT'});
});

test('site build renders /contract from CONTRACT.md, links it only when it exists and refuses a malformed contract', async t => {
 const f = await seed(t), page = name => readFile(join(f.root, 'dist/site', name), 'utf8');
 let result = await f.build();
 assert.equal(result.code, 0, result.stdout + result.stderr);
 await assert.rejects(page('contract.html'), {code:'ENOENT'});
 for (const name of ['index.html', 'run.html', '404.html']) assert.doesNotMatch(await page(name), /href="\/contract"/);
 const rows = [['HOME-001', 'Public landing', 'published', 'done', '`src/site/pages.ts`', ''], ['HOME-002', 'Owner sign-in', 'published', 'partial', '`src/core/app/identity.ts`', 'no second factor'], ['SYNC-001', 'Offline edits', 'target', 'missing', '', 'not implemented']];
 const contract = rows => ['# Contract', '', '## Product target', '', '| | |', '| --- | --- |', '| Category | Team notes |', '| Incumbents a buyer switches from | Notion, Confluence |', '| First buyer | A small US team |', '',
  '## Pages', '', '- **HOME-001 — Public landing.** The homepage.', '- **HOME-002 — Owner sign-in.** The owner signs in.', '', '## Target clauses', '', '### Working offline', '', '- **SYNC-001 — Offline edits.** Edits merge.', '',
  '## Status', '', 'Judged from the code and tests at commit `0123abcd` (16 October 2026).', '', '| Clause | Title | Kind | Status | Evidence | Gap |', '| --- | --- | --- | --- | --- | --- |', ...rows.map(row => `| ${row.join(' | ')} |`), ''].join('\n');
 const counts = async () => Object.fromEntries(['done', 'partial', 'missing', 'total'].map(key => [key, Number(/<section id="progress"[^>]*>/.exec(html)[0].match(new RegExp(`data-${key}="(\\d+)"`))[1])]));
 const { parseContract } = await import('../foundation/runtime/seed-contract.mjs');
 let html;
 for (const [index, status, gap] of [[-1], [0, 'missing', 'not shipped']]) {
  if (index >= 0) Object.assign(rows[index], { 3: status, 4: '', 5: gap });
  const text = contract(rows);
  await writeFile(join(f.root, 'CONTRACT.md'), text);
  result = await f.build();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  html = await page('contract.html');
  const parsed = parseContract(text).counts;
  assert.deepEqual(await counts(), parsed);
  assert.match(html, new RegExp(`${parsed.done} of ${parsed.total} clauses done`));
  assert.equal([...html.matchAll(/<tr class="clause"[^>]*data-status="missing"/g)].length, parsed.missing);
  for (const name of ['index.html', 'run.html', '404.html', 'contract.html']) assert.match(await page(name), /href="\/contract"/);
 }
 assert.deepEqual(await counts(), { done: 0, partial: 1, missing: 2, total: 3 });
 const broken = contract(rows).replace('| HOME-002 | Owner sign-in | published | partial |', '| HOME-002 | Owner sign-in | published |');
 await writeFile(join(f.root, 'CONTRACT.md'), broken);
 result = await f.build();
 assert.notEqual(result.code, 0);
 const line = broken.split('\n').findIndex(text => text.startsWith('| HOME-002')) + 1;
 assert.match(result.stdout + result.stderr, new RegExp(`CONTRACT\\.md:${line}: A Status row has 6 cells`));
 assert.match(await page('contract.html'), /0 of 3 clauses done/);
});

test('built Run command accepts one repository argument and refuses shell syntax', async t => {
 const f = await seed(t), data = join(f.root, 'src/site/run.ts');
 const original = await readFile(data, 'utf8');
 const valid = 'owner/run-repo_2.js';
 await writeFile(data, original.replace('npx -y @runeditrun/rer dev runeditrun/base', `npx -y @runeditrun/rer dev ${valid}`));
 const built = await f.build();
 assert.equal(built.code, 0, built.stdout + built.stderr);
 const html = await readFile(join(f.root, 'dist/site/run.html'), 'utf8');
 const command = /data-copy="([^"]+)"/.exec(html)[1].replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
 const result = await run('/bin/sh', ['-c', `curl() { :; }; sh() { printf '%s\\n' "$@"; }; ${command}`]);
 assert.deepEqual(result.stdout.trim().split('\n'), ['-s', '--', 'dev', valid]);
 for (const repo of ['owner/r; printf INJECTED', 'owner/r$(printf INJECTED)', 'owner/r`printf INJECTED`', 'owner/with space', "owner/r'quote", 'owner/repo\ntrue', 'owner/repo\n', '-owner/repo', 'owner/../repo']) {
  await writeFile(data, original.replace(/clone: '[^']*'/, `clone: ${JSON.stringify('npx -y @runeditrun/rer dev ' + repo)}`));
  const failed = await f.build();
  assert.notEqual(failed.code, 0, repo);
  assert.match(failed.stdout + failed.stderr, /valid repository id/, repo);
 }
});

test('built Roadmap preserves product prose while removing explicit source citations', async t => {
 const f = await seed(t);
 const source = (await readFile(join(base, 'foundation/fixtures/slate-contract-e60b107.md'), 'utf8'));
 const prose = '.NET public/private CLI/MCP Docs/Sheets/Slides package/revision Claim.MD/Availity https://www.ssa.gov/oact/cola/cbb.html https://status.cloud.google.com/incidents.json Next.js Normalize.css Animate.css ASP.NET v1.2.3 e.g. 3.14 example.com defaced React.js Node.js Socket.io Vue.js D3.js Nuxt.js three.js decimal deadheaded decade feedback';
 const input = source.replace(/^(\| `COLLAB-001`[^\n]*?)\| see the clause \|/m, (_, row) => `${row}| ${prose}; inspect \`src/private.ts\`, tests/private.test.mjs, README.md and commit a1234567890b. |`);
 assert.notEqual(input, source);
 await writeFile(join(f.root, 'CONTRACT.md'), input);
 const built = await f.build();
 assert.equal(built.code, 0, built.stdout + built.stderr);
 const preview = await sitePreview(join(f.root, 'dist/site'), {ports:[0]}), browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 try {
  const page = await browser.newPage(); await page.goto(preview.url + '/contract');
  const clause = page.locator('tr.clause[data-id="COLLAB-001"]');
  const text = await clause.textContent();
  for (const word of prose.split(' ')) assert.ok(text.includes(word), word);
  assert.doesNotMatch(text, /src\/private|tests\/private|README\.md|a1234567890b/);
  for (const word of prose.split(' ')) {
   await page.locator('input[type="search"]').fill(word);
   assert.equal(await clause.isVisible(), true, `search finds ${word}`);
  }
 } finally { await browser.close(); await preview.close(); }
});

test('built chooser keeps self first and carries each paid plan through the shared entry', async t => {
 const f = await seed(t), data = join(f.root, 'src/site/run.ts'), renderer = join(f.root, 'src/base/run-site.ts');
 const original = await readFile(data, 'utf8'), source = await readFile(renderer, 'utf8');
 const preview = await sitePreview(join(f.root, 'dist/site'), {ports:[0]}), browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 try {
  const page = await browser.newPage();
  for (const [mode, product, managed] of [['request', 'errors-workbench', true], ['app', 'errors-workbench', true], ['app', 'errors-workbench', false], ['app', null, true]]) {
   await writeFile(data, original.replaceAll("runeditrun/base", 'just-every/run-spool').replace("product: null", `product: ${JSON.stringify(product)}, managed: { open: ${managed} }`));
   await writeFile(renderer, source.replace("signups: 'request' as", `signups: '${mode}' as`));
   const result = await f.build();
   assert.equal(result.code, 0, result.stdout + result.stderr);
   await page.goto(preview.url + '/run');
   assert.deepEqual(await page.locator('.chooser section[aria-labelledby]').evaluateAll(sections => sections.filter(s => !s.closest('.paste-panel')).map(s => s.getAttribute('aria-labelledby'))), ['self', 'assisted', 'managed']);
   assert.equal(await page.locator('button').count(), 1);
   const closed = mode === 'request' || product === null;
   assert.equal(await page.locator('.assisted .chip').count(), Number(closed));
   assert.equal(await page.locator('.managed .chip').count(), Number(closed || !managed));
   for (const plan of ['assisted', 'managed']) {
    const href = new URL(await page.locator(`.${plan} a`).getAttribute('href'));
    assert.deepEqual([href.origin, href.searchParams.get('product'), href.searchParams.get('plan')], ['https://app.runeditrun.com', product ?? 'run-spool', plan]);
   }
   const entry = await page.locator('.assisted a').getAttribute('href');
   await page.goto(preview.url + '/docs/hosting');
   assert.equal(await page.locator('.assisted a').getAttribute('href'), entry);
   assert.equal(await page.locator('.assisted .go p').count(), Number(closed), 'hosting follows the same sign-ups and listing state');
  }
 } finally { await browser.close(); await preview.close(); }
});
