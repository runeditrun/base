import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployProductFixture, productDirectory, stagedModule, stagedHtml, stageProduct } from './fixtures/deploy-product.mjs';

// Public dispatcher, hook/build and real owner kit; only provider/hosted HTTP is fake.
test('declared custom product survives dry run and ships its staged bytes with owner finalization', async t => {
 const f = await deployProductFixture(t);
 await assert.rejects(access(join(f.root, productDirectory)), {code:'ENOENT'});
 await assert.rejects(access(join(f.root, 'migrations/core')), {code:'ENOENT'});
 const dry = await f.run('--dry-run');
 assert.equal(dry.code, 0, dry.error);
 assert.equal(await readFile(join(f.root, productDirectory, 'dist/server/index.js'), 'utf8'), stagedModule);
 assert.equal(f.provider.state.writes.length, 0);
 assert.ok(f.provider.state.calls.length > 0);
 assert.ok(f.provider.state.calls.every(call => call.method === 'GET'));
 await assert.rejects(access(join(f.root, '.rer/deploy/production.json')), {code:'ENOENT'});
 const ship = await f.run();
 assert.equal(ship.code, 0, ship.error);
 assert.equal(f.provider.state.content.get(f.provider.state.version.id).files.find(file => file.path === 'index.js').bytes.toString(), stagedModule);
 assert.ok(f.assets.includes(stagedHtml), 'the staged client bytes reach the provider');
 assert.ok(f.provider.state.databases[0].db.prepare("SELECT name FROM sqlite_master WHERE name='staged_product'").get(), 'the staged migration reached D1');
 assert.equal(f.claims.length, 1);
 assert.ok(f.claims[0].matches);
 assert.equal(f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'), false);
 const record = JSON.parse(await readFile(join(f.root, '.rer/deploy/production.json'), 'utf8'));
 assert.equal(record.ownerClaim.outcome, 'claimed');
 assert.ok(record.retiredSecrets.includes('SETUP_TOKEN'));
 assert.equal(record.receipt.provider.versionId, f.provider.state.version.id);
 assert.ok(f.health.length > 0);
 await rm(join(f.root, productDirectory), {recursive:true});
 assert.equal((await f.run('--remove','--yes')).code, 0);
 assert.equal(f.provider.state.settings, null);
 assert.equal(f.provider.state.databases.length, 0);
 await assert.rejects(access(join(f.root, '.rer/deploy/production.json')), {code:'ENOENT'});
});

test('standard owner deploy builds and checks the selected product while omitted selection keeps the checkout product', async t => {
 for (const staged of [true, false]) await t.test(staged ? 'staged product' : 'checkout product', async t => {
  const f = await deployProductFixture(t, {custom:false, rootProduct:!staged, stage:staged, declaration:staged ? {productDirectory} : {}});
  const dry = await f.run('--dry-run');
  assert.equal(dry.code, 0, dry.error);
  assert.equal(f.provider.state.writes.length, 0);
  const ship = await f.run();
  assert.equal(ship.code, 0, ship.error);
  const source = f.provider.state.content.get(f.provider.state.version.id).files.find(file => file.path === 'index.js').bytes.toString();
  assert.equal(source, staged ? stagedModule : await readFile(join(f.root, 'dist/server/index.js'), 'utf8'));
  assert.ok(f.assets.includes(staged ? stagedHtml : 'app'));
  assert.ok(f.health.length > 0, 'the real kit and wrapper checked hosted readiness');
  assert.equal(f.claims.length, 1);
 });
});

test('rer deploy refuses unsafe or absent declared products before provider changes', async t => {
 const f = await deployProductFixture(t, {rootProduct:true, stage:false});
 await stageProduct(f.root);
 await symlink(join(f.root, '..'), join(f.root, 'outside-product'), 'dir');
 await symlink(join(f.root, productDirectory), join(f.root, 'inside-product'), 'dir');
 await mkdir(join(f.root, 'linked-parent'), {recursive:true});
 await symlink(join(f.root, '.rer/deploy'), join(f.root, 'linked-parent/deploy'), 'dir');
 await writeFile(join(f.root, 'product-file'), 'not a directory');
 const declaration = JSON.parse(await readFile(join(f.root, 'deploy.json'), 'utf8'));
 for (const value of ['../x', f.root, 'C:/product', 'C:product', '\\product', '', null, 7, './.rer/deploy/product', '.rer//deploy/product', '.rer/deploy/product/', '.rer/deploy/../deploy/product', 'missing-product', 'product-file', 'outside-product', 'inside-product', 'linked-parent/deploy/product']) {
  await writeFile(join(f.root, 'deploy.json'), JSON.stringify({...declaration, productDirectory:value}));
  const result = await f.run('--dry-run');
  assert.equal(result.code, 4, `productDirectory ${JSON.stringify(value)}: ${result.error}`);
  assert.equal(f.provider.state.calls.length, 0);
  assert.equal(f.provider.state.writes.length, 0);
 }
});

test('staging a custom product does not let dry run succeed without provider credentials', async t => {
 const f = await deployProductFixture(t);
 delete process.env.CLOUDFLARE_ACCOUNT_ID;
 delete process.env.CLOUDFLARE_API_TOKEN;
 const result = await f.run('--dry-run');
 assert.equal(result.code, 3, result.error);
 assert.equal(await readFile(join(f.root, productDirectory, 'dist/client/index.html'), 'utf8'), stagedHtml);
 assert.equal(f.provider.state.calls.length, 0);
 assert.equal(f.provider.state.writes.length, 0);
});
