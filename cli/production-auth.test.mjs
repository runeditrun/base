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
 assert.match(error(await seed.run(['deploy'],4)).message,/Production sign-in is not configured/);
 assert.match(error(await seed.run(['deploy','--dry-run'],4)).message,/Production sign-in is not configured/);
 // Removing both integrations does not erase an auth installation's contract.
 const manifestPath=join(seed.root,'rer-setup.json'),manifest=await readFile(manifestPath,'utf8');
 const declarationPath=join(seed.root,'deploy.json'),originalDeclaration=await readFile(declarationPath,'utf8');
 const noProviders=JSON.parse(manifest);delete noProviders.dependencies;
 await writeFile(manifestPath,JSON.stringify(noProviders));
 const noMail=JSON.parse(originalDeclaration);noMail.vars={AUTH_LOCAL:'false'};noMail.secrets=noMail.secrets.filter(item=>!item.binding.startsWith('MAIL_'));
 await writeFile(declarationPath,JSON.stringify(noMail));
 assert.match(error(await seed.run(['deploy'],4)).message,/Production sign-in is not configured/);
 await writeFile(manifestPath,manifest);await writeFile(declarationPath,originalDeclaration);
 await writeFile(join(seed.root,'production.env'),'MAIL_API_KEY=test-only-mail-credential\n',{mode:0o600});
 const configured=await seed.run(['deploy','--env-file','production.env'],4);
 assert.match(error(configured).message,/not committed/,'valid production mail gets past sign-in preflight');
 assert.ok(!JSON.stringify(configured).includes('test-only-mail-credential'));
 // Managed RER mail counts as outbound only with its assigned relay URL.
 const managed=JSON.parse(originalDeclaration);managed.vars.MAIL_PROVIDER='rer';
 await writeFile(declarationPath,JSON.stringify(managed));
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/Production sign-in is not configured/);
 managed.vars.MAIL_RELAY_URL='https://mail.example.test/install/relay';
 await writeFile(declarationPath,JSON.stringify(managed));
 assert.match(error(await seed.run(['deploy','--env-file','production.env'],4)).message,/not committed/);
 await writeFile(declarationPath,originalDeclaration);
 await assert.rejects(access(join(seed.root,'dist')),{code:'ENOENT'});
 // Demo mode can never enter a production binding, even with valid mail.
 const declaration=JSON.parse(await readFile(join(seed.root,'deploy.json'),'utf8'));
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...declaration,vars:{...declaration.vars,RER_DEMO:'1'}}));
 for(const flags of [[],['--dry-run']])assert.match(error(await seed.run(['deploy','--env-file','production.env',...flags],4)).message,/local-only key RER_DEMO/);
});
