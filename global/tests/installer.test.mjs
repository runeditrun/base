// The script channel through its public doors: the package's own install.sh and
// `rer update`, against a local registry serving the real package tarball.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { tarball } from '../../scripts/rer-package/tarball.mjs';
import { integrity, localRegistry } from '../../scripts/rer-package/registry.mjs';
import { readPackage } from '../update/archive.mjs';

const base = resolve(import.meta.dirname, '../..');

function run(program, args, env, input, cwd) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { env, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input !== undefined) child.stdin.end(input);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.once('error', reject);
  child.once('close', code => resolveRun({ code, stdout, stderr }));
 });
}

// The default seed's Run page as `rer build --site` renders it, and the commands in its code blocks.
async function runPageCommands() {
 const seed = createRequire(join(base, 'default-seed/package.json')), { build } = createRequire(seed.resolve('wrangler/package.json'))('esbuild');
 const bundle = await build({ entryPoints: [join(base, 'default-seed/src/site/pages.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
 const { sitePages } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
 const html = sitePages({ styles: [], clients: {} }).pages.find(page => page.path === '/run').html;
 const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
 // A block's command is its text: inline spans only keep words together when it wraps.
 const commands = source => [...source.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map(match => match[1].replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, entity => entities[entity]));
 const disclosure = /<details class="other-ways"([^>]*)>([\s\S]*?)<\/details>/.exec(html);
 return {
  primary: commands(html.replace(disclosure?.[0] ?? '', '')),
  secondary: commands(disclosure?.[2] ?? ''),
  secondaryClosed: !!disclosure && !/\bopen(?:[\s=]|$)/.test(disclosure[1]),
 };
}

// The built package again under another version, optionally with extra raw entries.
function repack(entries, version, extra = []) {
 const files = entries.map(entry => ({ path: `package/${entry.path}`, data: entry.path === 'package.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(entry.data), version }, null, 2) + '\n') : entry.data, executable: entry.executable }));
 return tarball([...files, ...extra], 0);
}

test('install.sh and rer update install verified registry releases, the Run page starts an app on what install.sh installed and its last line puts rer on PATH for new shells, and a bad download leaves the current one', { timeout: 5 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-installer-')), home = join(directory, 'home');
 const registry = await localRegistry();
 t.after(async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); });

 const built = await readFile(await buildPackage(base, join(directory, 'built')));
 const entries = readPackage(built, { integrity: integrity(built) });
 const manifest = JSON.parse(entries.find(entry => entry.path === 'package.json').data);
 const installer = join(directory, 'install.sh');
 await writeFile(installer, entries.find(entry => entry.path === 'install.sh').data);

 const bin = join(directory, 'bin');
 await mkdir(bin);
 await symlink(process.execPath, join(bin, 'node'));
 const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/sh', TMPDIR: directory, npm_config_registry: registry.url };
 const rer = join(home, '.local/bin/rer');
 const selected = async () => (await run(rer, ['--version'], env)).stdout.trim();

 // A development build is published; install.sh installs it.
 registry.publish(manifest.version, built);
 // Business connect runs directly from the installer without asking the agent
 // to start an app or change PATH, both on first install and on reuse.
 const businessEnv = { ...env, HOME: join(directory, 'business-home') };
 const businessRer = join(businessEnv.HOME, '.local/bin/rer');
 for (let attempt = 0; attempt < 2; attempt++) {
  const connected = await run('sh', [installer, 'business', 'connect', '--help'], businessEnv);
  assert.equal(connected.code, 0, connected.stderr);
  assert.doesNotMatch(connected.stdout + connected.stderr, /rer dev|\bPATH\b/);
  const help = await run(businessRer, ['business', 'connect', '--help'], businessEnv);
  assert.equal(help.code, 0, help.stderr);
  assert.ok(help.stdout.length > 0 && connected.stdout.endsWith(help.stdout), 'the installer runs the requested business command');
 }
 assert.equal((await run(businessRer, ['cli', 'uninstall'], businessEnv)).code, 0);
 const installed = await run('sh', [installer], env);
 assert.equal(installed.code, 0, installed.stderr);
 assert.equal(await selected(), manifest.version);
 const readme = entries.find(entry => entry.path === 'README.md').data.toString();
 const separate = /```sh\ncurl[^\n]+\n([^\n]+)\n```/.exec(readme)?.[1];
 assert.ok(separate?.startsWith('"$HOME/.local/bin/rer" dev '), 'the literal README second step names the installed launcher');
 const literal = await run('sh', ['-c', separate + ' --help'], env);
 assert.equal(literal.code, 0, literal.stderr);
 assert.match(literal.stdout, /Usage: rer dev/);

 assert.deepEqual(await readdir(bin), ['node'], 'installation never writes into another writable PATH directory');
 // A stale lockfile reaches the packed CLI, with the real pinned pnpm and a
 // local dependency, so diagnosis and its next command need no registry.
 const fixture = join(directory, 'synthetic-base-1');
 await mkdir(fixture);
 await writeFile(join(fixture, '.node-version'), process.versions.node + '\n');
 const packagePath = join(fixture, 'package.json');
 const pkg = { name: 'synthetic-base-1', private: true, packageManager: 'pnpm@10.12.4', engines: { node: process.versions.node } };
 await writeFile(packagePath, JSON.stringify(pkg));
 const pnpmEnv = { ...process.env, HOME: home, CI: 'true' };
 const locked = await run('pnpm', ['install', '--lockfile-only'], pnpmEnv, undefined, fixture);
 assert.equal(locked.code, 0, locked.stderr);
 await mkdir(join(fixture, 'dependency'));
 await writeFile(join(fixture, 'dependency/package.json'), JSON.stringify({ name: 'synthetic-base-2', version: '1.0.0' }));
 pkg.dependencies = { 'synthetic-base-2': 'file:./dependency' };
 await writeFile(packagePath, JSON.stringify(pkg));
 const current = join(home, '.local/share/rer/current');
 await writeFile(join(fixture, 'adapter.mjs'), `import { localInstaller } from ${JSON.stringify('file://' + join(current, 'onboarding/adapter.mjs'))};
import { commandAdapter as declare } from ${JSON.stringify('file://' + join(current, 'cli/adapter.mjs'))};
export const commandAdapter = declare(localInstaller({ tools: [] }), { scheduled: false });
`);
 await writeFile(join(fixture, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'synthetic-base-1', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { install: { argv: ['node', 'adapter.mjs'], inputs: [], effects: 'Install dependencies.' } } }));
 const failed = await run(rer, ['install', '--no-queue'], pnpmEnv, undefined, fixture);
 t.diagnostic(`Stale packed install: ${failed.code}\n${failed.stdout}${failed.stderr}`);
 assert.notEqual(failed.code, 0);
 assert.match(failed.stderr, /pnpm-lock.yaml does not match package.json/);
 assert.doesNotMatch(failed.stdout + failed.stderr, /ERR_PNPM_|Last 20|Command:|Exit code:/);
 const data = await run(rer, ['install', '--no-queue', '--json'], pnpmEnv, undefined, fixture);
 const diagnostic = data.stdout.trim().split('\n').map(JSON.parse).find(row => row.event === 'error');
 assert.equal(diagnostic.code, 'ERR_PNPM_OUTDATED_LOCKFILE');
 assert.ok(diagnostic.step.output.some(line => line.includes('ERR_PNPM_OUTDATED_LOCKFILE')));
 const next = /run (.+) to update it, then retry/.exec(failed.stderr)?.[1];
 assert.ok(next, failed.stderr);
 const repaired = await run('sh', ['-c', next], pnpmEnv, undefined, fixture);
 assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
 assert.equal((await run(rer, ['install', '--no-queue'], pnpmEnv, undefined, fixture)).code, 0);
 await rm(join(fixture, 'pnpm-lock.yaml'));
 const absent = await run(rer, ['install', '--no-queue'], pnpmEnv, undefined, fixture);
 assert.notEqual(absent.code, 0);
 assert.match(absent.stderr, /pnpm-lock.yaml is missing/);
 assert.doesNotMatch(absent.stdout + absent.stderr, /ERR_PNPM_/);

 // The installer's last line puts rer on PATH: in the shell that runs it, and
 // in a new login shell of the person's SHELL that starts without it.
 const activate = output => { const last = output.trimEnd().split('\n').at(-1).trim(); return last.includes('.local/bin') ? last : undefined; };
 const hint = activate(installed.stdout);
 assert.ok(hint, installed.stdout);
 assert.equal(installed.stdout.match(/^Next, /gm)?.length, 1, `one next step, not two: ${installed.stdout}`);
 assert.equal((await run('sh', ['-c', `${hint}\nrer --version`], env)).stdout.trim(), manifest.version);
 assert.equal((await run('sh', ['-l', '-c', 'rer --version'], env)).stdout.trim(), manifest.version, 'a new shell finds rer after the line ran once');

 // The Run page hands its start arguments to install.sh in the same pipeline.
 // Its installed rer also runs with no npx or Node on PATH: the private Node
 // install.sh downloads when there is none stands in as its runtime link.
 const runtime = join(home, '.local/share/rer/node'), installedOnly = { ...env, PATH: join(home, '.local/bin') };
 await symlink(dirname(dirname(process.execPath)), runtime);
 // The managed launcher uses its private Node without making that Node's
 // sibling tools replace tools already selected by the caller.
 await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf "caller-npm\\n"\n', { mode: 0o755 });
 const checkTool = `import { execFileSync } from 'node:child_process';
if (execFileSync('npm', [], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' }).trim() !== 'caller-npm') throw Error('caller npm was shadowed');`;
 const callerTools = { ...env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(checkTool)}` };
 const managed = await run(rer, ['--version'], callerTools);
 assert.equal(managed.code, 0, managed.stderr);
 await rm(join(bin, 'npm'));
 const { primary: commands, secondary, secondaryClosed } = await runPageCommands();
 assert.equal(commands.length, 1, 'the Run page installs and starts with one primary command');
 assert.equal(secondary.length, 2, 'the separate install and launch commands stay in other ways');
 assert.equal(secondaryClosed, true, 'secondary commands are disclosed only on request');
 const pipeline = commands[0].split('|');
 assert.equal(pipeline.length, 2, 'the downloaded installer is piped to the shell');
 const [program, ...scriptArguments] = pipeline[1].trim().split(/\s+/);
 const startAt = scriptArguments.indexOf('--');
 assert.ok(startAt >= 0 && scriptArguments.length > startAt + 1, 'the shell forwards start arguments to the installer');
 // Supply the real downloaded script at the network edge. --help exercises
 // argument forwarding without cloning the reference or starting a server.
 const started = await run(program, [...scriptArguments, '--help'], env, await readFile(installer));
 assert.equal(started.code, 0, started.stderr);
 const direct = await run(rer, [...scriptArguments.slice(startAt + 1), '--help'], installedOnly);
 assert.equal(direct.code, 0, `the installed rer runs without Node or npx on PATH: ${direct.stderr}`);
 assert.ok(direct.stdout.trim() && started.stdout.endsWith(direct.stdout), 'the installer runs the Run page’s requested command with its installed rer');
 await rm(runtime);
 const status = JSON.parse((await run(rer, ['cli', 'status', '--json'], env)).stdout);
 assert.equal(status.channel, 'script');
 assert.deepEqual(status.others, []);

 // The clean release is published with a sha512 that does not match its bytes.
 const release = manifest.version.replace(/-.*$/, ''), releaseBytes = repack(entries, release);
 registry.publish(release, releaseBytes, { dist: { integrity: integrity(Buffer.from('other bytes')) } });
 const mismatched = await run('sh', [installer], env);
 assert.notEqual(mismatched.code, 0, 'install.sh refuses a download that does not match its integrity');
 assert.equal(await selected(), manifest.version, 'the previous install is still selected after install.sh refuses');
 const updateMismatched = await run(rer, ['update'], env);
 assert.notEqual(updateMismatched.code, 0, 'rer update refuses a download that does not match its integrity');
 assert.equal(await selected(), manifest.version, 'the previous install is still selected after rer update refuses');

 // Archives with entries that would write outside the package, verified by integrity.
 for (const [index, unsafe] of [
  [{ path: join(directory, 'escaped'), data: Buffer.from('outside'), executable: false }],
  [{ path: 'package/../escaped', data: Buffer.from('outside'), executable: false }],
  [{ path: 'package/global/hard', data: Buffer.alloc(0), type: '1', linkname: 'package/README.md' }],
  [{ path: 'package/global/link', data: Buffer.alloc(0), type: '2', linkname: '/etc' }],
 ].entries()) {
  registry.publish(`${release}-unsafe.${index}`, repack(entries, `${release}-unsafe.${index}`, unsafe));
  const refused = await run('sh', [installer], env);
  assert.notEqual(refused.code, 0, `install.sh refuses ${unsafe[0].path}`);
  assert.equal(await selected(), manifest.version);
  await assert.rejects(access(join(directory, 'escaped')));
 }

 // The release is republished correctly: rer update moves the development build to it.
 registry.publish(release, releaseBytes);
 const updated = await run(rer, ['update'], env);
 assert.equal(updated.code, 0, updated.stderr);
 assert.equal(await selected(), release);
 assert.equal(JSON.parse((await run(rer, ['cli', 'status', '--json'], env)).stdout).channel, 'script', 'rer update keeps the script channel');
 const again = await run(rer, ['update'], env);
 assert.equal(again.code, 0, again.stderr);
 assert.equal(await selected(), release);
 // A foreign command earlier on PATH is preserved; current-shell activation works.
 const foreignBin = join(directory, 'foreign-bin');
 await mkdir(foreignBin);
 await writeFile(join(foreignBin, 'rer'), '#!/bin/sh\nprintf "foreign\\n"\n', { mode: 0o755 });
 const isolated = { ...env, HOME: join(directory, 'activation-home'), PATH: `${foreignBin}:${join(directory, 'activation-home/.local/bin')}:${env.PATH}` };
 const activation = await run('sh', [installer], isolated);
 assert.equal(activation.code, 0, activation.stderr);
 const line = activate(activation.stdout);
 assert.ok(line, activation.stdout);
 assert.ok(activation.stdout.includes(join(foreignBin, 'rer')), 'installation names the existing command it leaves alone');
 assert.equal((await run('sh', ['-c', `${line}\nrer --version`], isolated)).stdout.trim(), release);
 assert.equal((await run('sh', ['-l', '-c', 'rer --version'], isolated)).stdout.trim(), release, 'a new shell puts the installed rer before the foreign one');
 assert.equal((await run(join(foreignBin, 'rer'), [], isolated)).stdout.trim(), 'foreign');
 const activeEnv = { ...isolated, PATH: `${join(isolated.HOME, '.local/bin')}:${isolated.PATH}` };
 const active = await run('sh', [installer], activeEnv);
 assert.equal(active.code, 0, active.stderr);
 assert.equal(activate(active.stdout), undefined, 'no line when the installed launcher is first now and in new shells');
 assert.ok(active.stdout.includes(join(foreignBin, 'rer')), 'a later existing command is also named and preserved');
 assert.deepEqual(await readdir(bin), ['node']);
 // Uninstall removes only recorded links still pointing at this canonical launcher.
 const removed = await run(rer, ['cli', 'uninstall'], env);
 assert.equal(removed.code, 0, removed.stderr);
 await assert.rejects(access(join(bin, 'rer')));
 const activationRer = join(isolated.HOME, '.local/bin/rer');
 assert.equal((await run(activationRer, ['cli', 'uninstall'], isolated)).code, 0);
 assert.equal((await run(join(foreignBin, 'rer'), [], isolated)).stdout.trim(), 'foreign');
});
