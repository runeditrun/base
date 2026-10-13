import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sshTarget, quote } from '../ssh.mjs';
import { installationIdentity } from '../ssh-plan.mjs';
const execute = promisify(execFile);
export const host = process.env.RER_SSH_TEST_HOST;
export const image = process.env.RER_SSH_TEST_IMAGE;
export const base = resolve(import.meta.dirname, '../../..');
export async function docker(...args) { return (await execute('docker', args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
export async function ssh(command) { return (await execute('ssh', [...sshTarget(host), command], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
export const inspect = async (kind, name) => JSON.parse(await docker(kind, 'inspect', name))[0];
export async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-ssh-safety-'));
 const home = await ssh('pwd');
 const environment = 'test-' + randomUUID().slice(0, 8), installations = [];
 await cp(join(base, 'default-seed'), root, { recursive: true, filter: path => !['node_modules', '.rer', '.seed', '.cache', '.wrangler', 'dist', '.dev.vars'].some(part => path.split('/').includes(part)) });
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 const secret = 'private-$value-"quoted"-' + randomUUID();
 async function select(project, origin, env = environment, ingress) {
  await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, project, container: { ...declaration.container, ...(ingress ? { ingress } : {}) } }));
  await writeFile(join(root, 'private.env'), `AUTH_ORIGIN=${origin}\nOWNER_EMAIL=proof@example.invalid\nSESSION_SECRET=${secret}\nSETUP_TOKEN=private-test-only\n`, { mode: 0o600 });
  const identity = installationIdentity(project, env);
  if (!installations.some(item => item.name === identity.name)) installations.push(identity);
  return { ...identity, environment: env, origin };
 }
 async function cli(installation, { packaged = false, extra = [], env = {}, success = true } = {}) {
  let result;
  try {
   result = await execute(process.execPath, [packaged ? join(root, 'scripts/rer.mjs') : join(base, 'bin/rer.mjs'), 'deploy', '--platform', 'container', '--host', host, '--env-file', 'private.env', '--environment', installation.environment, '--image', image, '--no-queue', '--non-interactive', '--json', ...extra], { cwd: root, env: { ...process.env, CI: 'true', ...env }, timeout: 180000, maxBuffer: 1024 * 1024 });
   result.code = 0;
  } catch (error) { result = error; }
  assert.ok(!(result.stdout + result.stderr).includes(secret), 'private input must never appear in CLI output');
  if (success) assert.equal(result.code, 0, result.stdout + result.stderr);
  else assert.notEqual(result.code, 0, 'hostile deployment must be refused');
  const events = result.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
  return { ...result, result: events.findLast(event => event.event === 'result') };
 }
 t.after(async () => {
  for (const installation of installations) {
   // The fixture owns only these generated test identities. Check labels before
   // every cleanup; unlabeled collisions are explicitly removed by their test.
   for (const [kind, roles] of [['container', ['app', 'caddy']], ['network', ['ingress']], ['volume', ['data', 'caddy', 'caddy-config']]]) {
    for (const role of roles) {
     const name = installation.name + '-' + role;
     let item; try { item = await inspect(kind, name); } catch { continue; }
     const labels = kind === 'container' ? item.Config.Labels : item.Labels;
     assert.equal(labels?.['io.runeditrun.installation'], installation.labels['io.runeditrun.installation']);
     await docker(kind, 'rm', ...(kind === 'container' ? ['-f'] : []), name);
    }
   }
   await ssh('rm -rf -- ' + quote(home + '/.rer-host/' + installation.name));
  }
  await rm(root, { recursive: true, force: true });
 });
 return { root, home, secret, select, cli, environment, installations };
}
export async function ownerLabels(installation) {
 for (const [kind, roles] of [['container', ['app']], ['volume', ['data']], ['network', ['ingress']]]) for (const role of roles) {
  const item = await inspect(kind, installation.name + '-' + role), labels = kind === 'container' ? item.Config.Labels : item.Labels;
  for (const [key, value] of Object.entries(installation.labels)) assert.equal(labels[key], value);
 }
}
export const running = async installation => (await inspect('container', installation.name + '-app')).Id;
export const currentPath = async (installation, home) => home + '/.rer-host/' + installation.name + '/' + JSON.parse(await ssh('cat ' + quote(home + '/.rer-host/' + installation.name + '/current.json'))).generation;

export async function interruptStage(directory, replaceWith, generation) {
 const code=await readFile(new URL('./interrupt-stage.py',import.meta.url),'utf8');
 const args=[directory,...(replaceWith?[replaceWith]:[]),...(generation?[generation.target,generation.saved]:[])];
 const child=spawn('ssh',[...sshTarget(host),'python3 -I -c '+quote(code)+' '+args.map(quote).join(' ')],{stdio:['ignore','pipe','pipe']});
 let output='',error='';child.stderr.on('data',chunk=>error+=chunk);
 const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(Error('Stage watcher failed: '+error)));});
 await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY'))resolve();});child.once('error',reject);child.once('close',()=>{if(!output.includes('READY'))reject(Error('Stage watcher did not start'));});});
 return {finished,stop:()=>child.kill('SIGTERM')};
}
