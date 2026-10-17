import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportReference } from '../scripts/export-reference.mjs';
import { createRequire } from 'node:module';
import { sitePreview } from './site-preview.mjs';
import { freePort } from '../global/tests/harness.mjs';
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
 const build = async () => {
  try { const result = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'build', '--site', '--json', '--no-queue'], { cwd: root, env: { PATH:process.env.PATH, HOME:join(directory, 'home'), TZ:'UTC', CI: 'true', RER_NO_UPDATE_CHECK: '1' }, maxBuffer: 1024 * 1024 }); return {code:0, ...result}; }
  catch (error) { return {code:error.code, stdout:error.stdout, stderr:error.stderr}; }
 };
 return { root, adapter, original, pages, render, build };
}

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
 const preview = await sitePreview(join(f.root,'dist/site'), {ports:[await freePort()]}), browser = await chromium.launch({headless:true});
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
