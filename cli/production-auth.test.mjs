import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { portabilityFixture } from './fixtures/portability.mjs';

// Public commands on the real exported seed. Deliberately dirty source stops a
// configured deployment before its build or any provider request.
test('rer deploy refuses missing production sign-in before building and accepts declared outbound settings', async t => {
 const seed = await portabilityFixture(t, { generated: false });
 const git = (...args) => execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false',...args], {cwd:seed.root,stdio:'pipe'});
 git('init','-q');git('add','package.json');git('commit','-qm','fixture');
 await writeFile(join(seed.root,'package.json'),(await readFile(join(seed.root,'package.json'),'utf8'))+'\n');
 const error = events => events.find(event => event.event === 'error');
 const demoBuild=spawnSync(process.execPath,['scripts/rer.mjs','build','--json'],{cwd:seed.root,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',RER_NODE_AUTO:'0',RER_DEMO:'1'},encoding:'utf8',timeout:15000});
 assert.equal(demoBuild.status,4);
 assert.match(demoBuild.stdout,/local-only RER_DEMO/);
 const unconfigured=error(await seed.run(['deploy'],4)).message;
 assert.match(unconfigured,/Production sign-in is not configured/);
 assert.match(unconfigured,/MAIL_API_KEY/);
 // Removing both integrations does not erase an auth installation's contract.
 const manifestPath=join(seed.root,'rer-setup.json'),manifest=await readFile(manifestPath,'utf8');
 const declarationPath=join(seed.root,'deploy.json'),originalDeclaration=await readFile(declarationPath,'utf8');
 const noProviders=JSON.parse(manifest);delete noProviders.dependencies;
 await writeFile(manifestPath,JSON.stringify(noProviders));
 const noMail=JSON.parse(originalDeclaration);noMail.vars={AUTH_LOCAL:'false'};noMail.secrets=noMail.secrets.filter(item=>!item.binding.startsWith('MAIL_'));
 await writeFile(declarationPath,JSON.stringify(noMail));
 const missingMail=error(await seed.run(['deploy'],4)).message;
 for(const field of ['MAIL_PROVIDER','MAIL_FROM','MAIL_API_KEY'])assert.ok(missingMail.includes(field));
 await writeFile(manifestPath,manifest);await writeFile(declarationPath,originalDeclaration);
 await writeFile(join(seed.root,'production.env'),'MAIL_API_KEY=test-only-mail-credential\n',{mode:0o600});
 const configured=await seed.run(['deploy','--env-file','production.env'],4);
 assert.match(error(configured).message,/not committed/,'valid production mail gets past sign-in preflight');
 assert.ok(!JSON.stringify(configured).includes('test-only-mail-credential'));
 // A seed can declare the provider's native binding, or map an environment
 // credential into the shared MAIL_API_KEY binding. Ambient keys do not count.
 const sendgrid=JSON.parse(originalDeclaration);sendgrid.vars.MAIL_PROVIDER='sendgrid';
 sendgrid.secrets=sendgrid.secrets.filter(item=>item.binding!=='MAIL_API_KEY');
 sendgrid.secrets.push({binding:'SENDGRID_API_KEY',environment:'SEED_MAIL_TOKEN'});
 await writeFile(declarationPath,JSON.stringify(sendgrid));
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/SENDGRID_API_KEY/);
 await writeFile(join(seed.root,'production.env'),'SEED_MAIL_TOKEN=test-only-sendgrid-credential\n',{mode:0o600});
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/not committed/);
 sendgrid.secrets.at(-1).binding='MAIL_API_KEY';
 await writeFile(declarationPath,JSON.stringify(sendgrid));
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/not committed/);
 sendgrid.vars.MAIL_PROVIDER='resend';sendgrid.secrets.at(-1).binding='SENDGRID_API_KEY';
 await writeFile(declarationPath,JSON.stringify(sendgrid));
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/MAIL_API_KEY/,'another provider cannot borrow SendGrid credentials');
 await writeFile(join(seed.root,'production.env'),'MAIL_API_KEY=test-only-mail-credential\n',{mode:0o600});
 // Managed RER mail counts as outbound only with its assigned relay URL.
 const managed=JSON.parse(originalDeclaration);managed.vars.MAIL_PROVIDER='rer';
 await writeFile(declarationPath,JSON.stringify(managed));
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/MAIL_RELAY_URL/);
 managed.vars.MAIL_RELAY_URL='https://mail.example.test/install/relay';
 await writeFile(declarationPath,JSON.stringify(managed));
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/not committed/);
 // Auth SSO remains an independent way to satisfy the preflight; the existing
 // dependency-link flow owns approval before any real deployment can proceed.
 const sso=JSON.parse(originalDeclaration);sso.vars={AUTH_LOCAL:'false',IDENTITY_PROVIDER:'https://auth.example.test'};
 sso.secrets=sso.secrets.filter(item=>!item.binding.startsWith('MAIL_'));
 await writeFile(declarationPath,JSON.stringify(sso));
 assert.match(error(await seed.run(['deploy'],4)).message,/not committed/);
 sso.vars.IDENTITY_PROVIDER='http://auth.example.test';
 await writeFile(declarationPath,JSON.stringify(sso));
 assert.match(error(await seed.run(['deploy'],4)).message,/Production sign-in is not configured/);
 await writeFile(declarationPath,originalDeclaration);
 await assert.rejects(access(join(seed.root,'dist')),{code:'ENOENT'});
 // Demo mode can never enter a production binding, even with valid mail.
 const declaration=JSON.parse(await readFile(join(seed.root,'deploy.json'),'utf8'));
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...declaration,vars:{...declaration.vars,RER_DEMO:'1'}}));
 for(const flags of [[],['--dry-run']])assert.match(error(await seed.run(['deploy','--env-file','production.env',...flags],4)).message,/local-only key RER_DEMO/);
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify(declaration));
 // A dry run goes ahead without production mail, OWNER_EMAIL and Cloudflare values, and lists them.
 const dry=(await seed.text(['deploy','--dry-run'])).stderr;
 assert.match(dry,/dry run complete/);
 const needed=dry.slice(dry.indexOf('Needed for a real deploy'));
 for(const name of ['CLOUDFLARE_ACCOUNT_ID','OWNER_EMAIL','MAIL_API_KEY','https://dash.cloudflare.com/profile/api-tokens','Workers Scripts: Edit','D1: Edit','Queues: Edit'])assert.ok(needed.includes(name),dry);
 // Without Cloudflare values a real deploy says where to get them: the token
 // page and the permissions this declaration needs, or the project's own guide.
 git('checkout','package.json');
 const noAccount=(await seed.text(['deploy','--env-file','production.env'],3)).stderr;
 assert.match(noAccount,/CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required/);
 for(const text of ['https://dash.cloudflare.com/profile/api-tokens','Workers Scripts: Edit','D1: Edit','Queues: Edit'])assert.ok(noAccount.includes(text),noAccount);
 const guide='https://guide.example.test/docs/operations#what-you-need-first';
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...declaration,deployGuide:guide}));
 const guided=(await seed.text(['deploy','--env-file','production.env'],3)).stderr;
 assert.ok(guided.includes(guide),guided);
 assert.doesNotMatch(guided,/profile\/api-tokens/);
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...declaration,deployGuide:'http://guide.example.test'}));
 assert.match(error(await seed.run(['deploy','--dry-run'],2)).message,/deployGuide must be an https URL/);
});

test('rer deploy resolves deferred mail from the product packaging contract before its custom deploy hook', async t => {
 const seed = await portabilityFixture(t, { generated: false });
 // A real product adapter may wrap the shared deploy hook to resolve its own
 // declaration later. The public command must validate its source inputs first.
 const descriptorPath = join(seed.root, 'OPERATIONS.json');
 const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
 await writeFile(join(seed.root, 'product-adapter.mjs'), `import {commandAdapter as seed} from './${descriptor.seedContract.adapter}';
export const commandAdapter = {...seed, deploy: context => seed.deploy(context)};\n`);
 descriptor.seedContract.adapter = 'product-adapter.mjs';
 await writeFile(descriptorPath, JSON.stringify(descriptor));
 const declarationPath = join(seed.root, 'deploy.json');
 const declaration = JSON.parse(await readFile(declarationPath, 'utf8'));
 declaration.vars = { AUTH_LOCAL: 'false', MAIL_PROVIDER: 'later' };
 declaration.secrets = declaration.secrets.filter(item => !item.binding.startsWith('MAIL_'));
 await writeFile(declarationPath, JSON.stringify(declaration));
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: seed.root, stdio: 'pipe' });
 git('init', '-q'); git('add', 'package.json'); git('commit', '-qm', 'fixture');
 await writeFile(join(seed.root, 'package.json'), (await readFile(join(seed.root, 'package.json'), 'utf8')) + '\n');
 const error = async values => {
  await writeFile(join(seed.root, 'production.env'), values, { mode: 0o600 });
  const events = await seed.run(['deploy', '--env-file', 'production.env'], 4);
  assert.ok(!JSON.stringify(events).includes('test-only-provider-credential'));
  return events.find(event => event.event === 'error').message;
 };
 const spec = { publicVariableNames: ['MAIL_PROVIDER', 'MAIL_FROM'], secretNames: ['AUTH_SECRET', 'SETUP_TOKEN'], optionalSecretNames: ['SENDGRID_API_KEY', 'RESEND_API_KEY'] };
 for (const [path, wrap] of [
  ['rer-packaging.json', spec => ({ artifact: { specInputs: spec } })],
  ['packaging.json', spec => ({ artifact: { specInputs: spec } })],
  ['scripts/delivery/base/packaging.json', spec => ({ artifact: { specInputs: spec } })],
  ['management/integration/deployment-spec.json', spec => spec],
 ]) {
  await mkdir(dirname(join(seed.root, path)), { recursive: true });
  await writeFile(join(seed.root, path), JSON.stringify(wrap(spec)));
  const missing = await error('');
  for (const name of ['MAIL_FROM', 'SENDGRID_API_KEY', 'RESEND_API_KEY']) assert.ok(missing.includes(name), missing);
  for (const key of ['SENDGRID_API_KEY', 'RESEND_API_KEY']) {
   assert.match(await error(`${key}=test-only-provider-credential\nMAIL_FROM=sender@example.test\n`), /not committed/, `${path}: declared native provider passes preflight`);
  }
  await rm(join(seed.root, path));
 }
 const packagingPath = join(seed.root, 'rer-packaging.json');
 await writeFile(packagingPath, JSON.stringify({ artifact: { specInputs: spec } }));
 assert.match(await error('SENDGRID_API_KEY=test-only-provider-credential\n'), /MAIL_FROM/);
 assert.match(await error('MAIL_FROM=sender@example.test\nMAIL_PROVIDER=resend\nSENDGRID_API_KEY=test-only-provider-credential\n'), /RESEND_API_KEY/, 'explicit provider cannot borrow another provider key');
 assert.match(await error('MAIL_FROM=sender@example.test\nMAIL_API_KEY=test-only-provider-credential\n'), /SENDGRID_API_KEY.*RESEND_API_KEY/, 'an ambiguous shared key does not resolve a deferred native provider');
 spec.optionalSecretNames = ['RESEND_API_KEY'];
 await writeFile(packagingPath, JSON.stringify({ artifact: { specInputs: spec } }));
 assert.match(await error('MAIL_FROM=sender@example.test\nSENDGRID_API_KEY=test-only-provider-credential\n'), /RESEND_API_KEY/, 'undeclared ambient provider key does not count');
 spec.publicVariableNames = ['MAIL_PROVIDER'];
 await writeFile(packagingPath, JSON.stringify({ artifact: { specInputs: spec } }));
 assert.match(await error('MAIL_FROM=sender@example.test\nRESEND_API_KEY=test-only-provider-credential\n'), /MAIL_FROM/, 'undeclared ambient sender does not count');
 // Fixed deployment-spec variables and the adapter's own deployment binding
 // are source declarations too; a mapped root secret keeps its environment name.
 await writeFile(packagingPath, JSON.stringify({ artifact: { specInputs: { publicVariables: { MAIL_PROVIDER: 'resend', MAIL_FROM: 'sender@example.test' }, optionalSecretNames: ['RESEND_API_KEY'] } } }));
 assert.match(await error('RESEND_API_KEY=test-only-provider-credential\n'), /not committed/);
 await rm(packagingPath);
 declaration.vars.MAIL_FROM = 'sender@example.test';
 declaration.secrets.push({ binding: 'SENDGRID_API_KEY', environment: 'PRODUCT_MAIL_TOKEN' });
 await writeFile(declarationPath, JSON.stringify(declaration));
 assert.match(await error('PRODUCT_MAIL_TOKEN=test-only-provider-credential\n'), /not committed/);
 assert.match(await error('SENDGRID_API_KEY=test-only-provider-credential\n'), /SENDGRID_API_KEY/, 'native key cannot bypass the declared environment mapping');
 await assert.rejects(access(join(seed.root, 'dist')), { code: 'ENOENT' });
});
