import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { command } from './docker.mjs';
import { hash } from './receipt.mjs';
import { digest } from '../../../scripts/qualification/operations.mjs';
export async function genericFixture(ctx, mode) {
  const root = join(ctx.root, 'generic-' + mode); mkdirSync(root);
  const directory = join(root, 'project'), cwd = 'nested-' + randomBytes(4).toString('hex'); mkdirSync(join(directory, cwd), { recursive: true });
  const credential = 'PROOF_' + randomBytes(6).toString('hex').toUpperCase() + '_CREDENTIAL';
  const marker = randomBytes(32).toString('hex'), markerHash = hash(marker), literal = 'literal argument ; $HOME is data'; ctx.receipt.secrets.push(marker);
  const descriptor = { version: 2, requiredEnvironment: [credential], commands: {
    setup: { argv: ['node', 'setup.mjs', '--remote', literal], cwd, target: 'remote' },
    deploy: { argv: ['sh', '-c', 'node deploy.mjs "$1" "$2"', 'declared-shell', '--remote', literal], cwd, target: 'remote' },
  } };
  const common = `import fs from 'node:fs';import assert from 'node:assert/strict';import crypto from 'node:crypto';const hash=b=>crypto.createHash('sha256').update(b).digest('hex');`;
  const controllerCheck = `assert.equal(process.cwd(),${JSON.stringify('/seed/' + cwd)});assert.equal(process.argv[2],'--remote');assert.equal(process.argv[3],${JSON.stringify(literal)});assert.equal(hash(process.env[${JSON.stringify(credential)}]),${JSON.stringify(markerHash)});`;
  const files = {
    'OPERATIONS.json': JSON.stringify(descriptor), '.gitignore': 'ignored-secret\n',
    [cwd + '/setup.mjs']: common + controllerCheck + `fs.writeFileSync('guard','controller-guard-${mode}');`,
    [cwd + '/deploy.mjs']: common + `import {spawnSync} from 'node:child_process';` + controllerCheck + `const r=spawnSync('pnpm',['build'],{stdio:'inherit',env:process.env});if(r.status!==0)process.exit(r.status??1);assert.equal(fs.readFileSync('guard','utf8'),'controller-guard-${mode}');assert.throws(()=>fs.writeFileSync('dist/payload.txt','controller-mutation'));const bytes=fs.readFileSync('dist/payload.txt');assert(bytes.toString().startsWith('pinned-build:'));fs.writeFileSync('publication-sentinel','test-only');console.log(JSON.stringify({payloadSha256:hash(bytes),guardSha256:hash(fs.readFileSync('guard')),literal:process.argv[3],cwd:process.cwd()}));`,
    [cwd + '/probe.mjs']: common + `export function probe(){assert(!Object.hasOwn(process.env,${JSON.stringify(credential)}));for(const v of Object.values(process.env))assert.notEqual(hash(v),${JSON.stringify(markerHash)});for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{for(const s of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0')){assert(!s.startsWith(${JSON.stringify(credential + '=')}));assert.notEqual(hash(s.slice(s.indexOf('=')+1)),${JSON.stringify(markerHash)});}}catch(e){if(!['ENOENT','EACCES','EPERM','ESRCH'].includes(e.code))throw e;}}for(const p of ['/broker','/harness','/route','/var/run/docker.sock','/source/ignored-secret','/source/untracked','/source/.git'])assert(!fs.existsSync(p));assert.throws(()=>fs.writeFileSync('/source/modified','x'));assert.throws(()=>fs.writeFileSync('/usr/local/bin/node','x'));assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);}`,
    [cwd + '/install.mjs']: `import {probe} from './probe.mjs';import fs from 'node:fs';probe();${mode === 'install-failure' ? 'process.exit(23);' : "fs.writeFileSync('installed','actual-pnpm-postinstall');"}`,
    [cwd + '/build.mjs']: common + `import {probe} from './probe.mjs';import {spawn} from 'node:child_process';probe();assert.equal(fs.readFileSync('installed','utf8'),'actual-pnpm-postinstall');${mode === 'build-failure' ? 'process.exit(29);' : `fs.mkdirSync('dist');fs.writeFileSync('dist/payload.txt','pinned-build:0');const child=spawn(process.execPath,['mutate.mjs'],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync('mutator-pid',String(child.pid));`}`,
    [cwd + '/mutate.mjs']: `import fs from 'node:fs';let n=0;setInterval(()=>{fs.writeFileSync('payload-next','pinned-build:'+ ++n);fs.renameSync('payload-next','dist/payload.txt')},2);`,
    [cwd + '/package.json']: JSON.stringify({ name: 'qualification-fixture', version: '1.0.0', type: 'module', scripts: { postinstall: 'node install.mjs', build: 'node build.mjs' } }),
    [cwd + '/pnpm-lock.yaml']: "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
  };
  for (const [path, bytes] of Object.entries(files)) writeFileSync(join(directory, path), bytes);
  const gitEnv = { ...ctx.env, GIT_AUTHOR_NAME: 'Qualification fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Qualification fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = args => command(ctx, ['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, env: gitEnv });
  await git(['init']); await git(['add', '.']); await git(['commit', '-m', 'Synthetic executor fixture']);
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.toString().trim();
  writeFileSync(join(directory, 'ignored-secret'), 'ignored fixture data'); writeFileSync(join(directory, 'untracked'), 'untracked');
  writeFileSync(join(directory, cwd, 'build.mjs'), "throw new Error('dirty-worktree-executed');\n");
  const adapter = { sourceSha: sha, descriptorSha256: digest(descriptor), requiredEnvironment: [credential], deploymentEnvironment: [credential],
    controllerFiles: Object.fromEntries(['setup.mjs', 'deploy.mjs'].map(name => [cwd + '/' + name, hash(files[cwd + '/' + name])])),
    builds: [{ argv: ['pnpm', 'build'], cwd, install: [['pnpm', 'install', '--offline', '--frozen-lockfile']], output: cwd + '/dist', environment: {} }],
    tools: { pnpm: { path: '/opt/trusted/bin/pnpm', allow: [] } }, journeyEnvironment: [], qualify: async () => {},
    validateArtifact: async ({ files }) => { if (files.length !== 1 || files[0].path !== 'dist/payload.txt') throw new Error('fixture-artifact-contract'); },
  };
  const work = join(root, 'work'); mkdirSync(work);
  return { directory, adapter, root: work, env: ctx.env, inputs: { [credential]: marker }, images: ctx.images, cwd, markerHash, descriptor, mode };
}
