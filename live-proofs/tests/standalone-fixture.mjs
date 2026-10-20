import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest } from '../../scripts/qualification/operations.mjs';

// A provider-free test project, never imported by production code.
export function standaloneFixture(root) {
  const directory = join(root, 'project'); mkdirSync(join(directory, 'product'), { recursive: true });
  const descriptor = { version: 2, project: 'test/independent', requiredEnvironment: ['PROVIDER_TOKEN'], health: { path: '/health' }, commands: {
    setup: { argv: ['node', 'setup.mjs', '--remote'], cwd: 'product', target: 'remote' },
    deploy: { argv: ['sh', '-c', 'node deploy.mjs "$1"', 'publisher', '--remote'], cwd: 'product', target: 'remote' },
  } };
  const source = {
    'OPERATIONS.json': JSON.stringify(descriptor),
    '.gitignore': 'private.env\n',
    'product/setup.mjs': `import fs from 'node:fs'; import assert from 'node:assert/strict'; assert(process.env.PROVIDER_TOKEN); assert.equal(process.argv[2],'--remote'); fs.writeFileSync('prepared.json','{"ready":true}');`,
    'product/deploy.mjs': `import fs from 'node:fs'; import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; assert(process.env.PROVIDER_TOKEN); assert.equal(process.argv[2],'--remote'); assert(JSON.parse(fs.readFileSync('prepared.json')).ready); const result=spawnSync('node',['build.mjs'],{stdio:'inherit',env:process.env}); if(result.status!==0)process.exit(result.status??1); assert.equal(fs.readFileSync('dist/payload.txt','utf8'),'actual-build'); console.log('literal-deployment-completed');`,
    'product/install.mjs': `import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(process.env.PROVIDER_TOKEN,undefined); assert.equal(process.env.EVIDENCE_WRITE_TOKEN,undefined); for(const path of ['/broker/build.sock','/harness','/route','/var/run/docker.sock'])assert(!fs.existsSync(path)); for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{assert(!fs.readFileSync('/proc/'+pid+'/environ','utf8').includes('PROVIDER_TOKEN='synthetic-));}catch(e){if(!['ENOENT','EACCES','EPERM','ESRCH'].includes(e.code))throw e;}} assert.throws(()=>fs.writeFileSync('/source/mutation','bad')); assert.throws(()=>fs.writeFileSync('/usr/local/bin/node','bad')); fs.writeFileSync('installed','real-install');`,
    'product/build.mjs': `import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(process.env.PROVIDER_TOKEN,undefined); assert.equal(fs.readFileSync('installed','utf8'),'real-install'); assert(JSON.parse(fs.readFileSync('prepared.json')).ready); fs.mkdirSync('dist'); fs.writeFileSync('dist/payload.txt','actual-build');`,
  };
  for (const [path, bytes] of Object.entries(source)) writeFileSync(join(directory, path), bytes);
  const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init']); git(['add', '.']); git(['commit', '-m', 'Test source']);
  writeFileSync(join(directory, 'private.env'), 'HOST_PRIVATE_FIXTURE=not-source');
  const adapter = { seed: 'independent', sourceSha: git(['rev-parse', 'HEAD']), descriptorSha256: digest(descriptor), requiredEnvironment: ['PROVIDER_TOKEN'],
    deploymentEnvironment: ['PROVIDER_TOKEN'],
    controllerFiles: Object.fromEntries(['product/setup.mjs', 'product/deploy.mjs'].map(path => [path, digest(source[path])])),
    builds: [{ argv: ['node', 'build.mjs'], cwd: 'product', install: [['node', 'install.mjs']], output: 'product/dist', environment: {} }],
    tools: { node: { path: '/usr/local/bin/node', allow: [['deploy.mjs', '--remote']] } },
    prepareBuild: async ({ readFile }) => [{ path: 'product/prepared.json', bytes: await readFile('product/prepared.json') }],
    validateArtifact: async ({ root, files }) => {
      if (files.length !== 1 || files[0].path !== 'dist/payload.txt' || readFileSync(join(root, 'dist/payload.txt'), 'utf8') !== 'actual-build') throw new Error('fixture-artifact-mismatch');
    },
    journeyEnvironment: [], qualify: async () => {},
  };
  return { directory, descriptor, adapter, env: { ...gitEnv, RUNNER_TEMP: root, T016_CONTAINER_LABEL: 't016-test-generic' } };
}
