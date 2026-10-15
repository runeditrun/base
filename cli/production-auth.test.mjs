import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
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
 assert.match(error(await seed.run(['deploy','--dry-run'],4)).message,/Production sign-in is not configured/);
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
});
