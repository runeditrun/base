// rer doctor with no project around it: is this computer ready to run an app?
// git, the Node rer runs on, the rer command on PATH, free disk against the
// server-start guard, github.com and the npm registry, and the loopback port
// rer dev starts from. Read-only; every look is bounded, so it answers offline
// too. A missing requirement fails (exit 3); what only slows a start warns.
import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { serversDiskFloor } from '../cli/server-resources.mjs';
import { probePort } from '../onboarding/port-probe.mjs';
import { gitPreflight } from './cli/repository.mjs';
import { rerWord } from './cli/invocation.mjs';
import { launcherWritten, layout } from './cli/layout.mjs';
import { pathAdvice } from './cli/path-link.mjs';
import { ownManifest } from './package-info.mjs';
import { serversDirectory } from './registry.mjs';

const usage = 'Usage: rer doctor [--json]\nOutside a project: checks this computer for what rer needs (git, Node, the rer command, disk, network, loopback port). Inside one: that project\'s diagnostics.\n';
const gib = bytes => `${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB`;

async function git(env) {
 try { return { status: 'ok', message: await gitPreflight(undefined, env) }; }
 catch (error) { return { status: 'fail', message: error.message }; }
}

function node() {
 const { data } = layout(), own = process.execPath.startsWith(data + '/');
 return { status: 'ok', message: `Node ${process.versions.node} runs rer${own ? ' (the private Node the installer keeps for rer)' : ` (${process.execPath})`}; rer fetches the Node version each app pins` };
}

async function launcher() {
 const paths = layout(), word = rerWord();
 if (!launcherWritten(paths.launcher)) return { status: 'warn', message: `rer is not installed for this user (this run is npx or a checkout). To keep it: ${word} cli install` };
 if (word === 'rer') return { status: 'ok', message: `rer ${ownManifest().version}: ${paths.launcher}, first on PATH` };
 return { status: 'warn', message: `${paths.launcher} is installed but not the first rer on PATH, so run it as ${word} for now. ${await pathAdvice(paths)}` };
}

async function disk(env) {
 const floor = serversDiskFloor(env), places = [...new Set([process.cwd(), resolve(env.TMPDIR || tmpdir()), serversDirectory(env)])];
 const free = await Promise.all(places.map(async path => { for (let at = path; ; at = dirname(at)) { try { const state = await statfs(at, { bigint: true }); return state.bavail * state.bsize; } catch (error) { if (error.code !== 'ENOENT' || dirname(at) === at) throw error; } } }));
 const least = free.reduce((min, value) => value < min ? value : min);
 return least < floor.bytes
  ? { status: 'fail', message: `${gib(least)} free; starting an app needs ${gib(floor.bytes)} free here, in the temporary folder and in ${serversDirectory(env)}. Free some space first.` }
  : { status: 'ok', message: `${gib(least)} free (a server start needs ${gib(floor.bytes)}; a first launch also stores the app's dependencies)` };
}

async function reach(name, url) {
 const started = Date.now();
 if (!URL.canParse(url)) return { status: 'warn', message: `${name} is not an address rer can reach (npm_config_registry).` };
 try { await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3000) }); return { status: 'ok', message: `${name} answers (${Date.now() - started} ms)` }; }
 catch { return { status: 'warn', message: `${name} did not answer within 3 s: offline, or behind a proxy this check does not use. Getting and installing an app needs it.` }; }
}

async function loopback(env) {
 const from = Number(env.RER_DEV_PORT_FROM ?? 8787);
 const result = await probePort('127.0.0.1', from, { hosts: ['127.0.0.1', '::1'], searching: true }).catch(error => ({ available: false, code: error.code }));
 if (result.available) return { status: 'ok', message: `127.0.0.1:${from} is free; rer dev starts the first app there` };
 if (result.code === 'EADDRINUSE') return { status: 'ok', message: `127.0.0.1:${from} is in use; rer dev takes the next free port` };
 return { status: 'fail', message: `rer cannot listen on 127.0.0.1 (${result.code ?? 'unknown error'}); apps run on this computer's loopback address` };
}

export async function machineDoctor(args, env = process.env) {
 if (args.some(arg => ['--help', '-h'].includes(arg))) { process.stdout.write(usage); return 0; }
 const json = args.includes('--json'), unknown = args.find(arg => arg !== '--json');
 if (unknown !== undefined) { process.stderr.write(`Unsupported flag ${unknown} for doctor outside a project. Run rer doctor --help.\n`); return 2; }
 const registry = (env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
 const names = ['git', 'node', 'rer', 'disk', 'github', 'registry', 'loopback'];
 const results = await Promise.all([git(env), node(), launcher(), disk(env), reach('github.com', 'https://github.com/'), reach(URL.canParse(registry) ? new URL(registry).host : registry, `${registry}/`), loopback(env)]);
 const checks = names.map((id, index) => ({ id, ...results[index] })), ok = checks.every(check => check.status !== 'fail'), exitCode = ok ? 0 : 3;
 if (json) { process.stdout.write(JSON.stringify({ version: 1, verb: 'doctor', event: 'result', ok, exitCode, diagnostics: { scope: 'machine', checks } }) + '\n'); return exitCode; }
 const lines = ['rer doctor: this computer (no project in this folder)', ...checks.map(check => `  ${check.status.padEnd(5)} ${check.id.padEnd(9)} ${check.message.replaceAll('\n', '\n                  ')}`)];
 lines.push(ok ? `This computer has what rer needs. Start an app with: ${rerWord()} dev owner/repo` : 'Fix the lines marked fail, then run rer doctor again.');
 process.stdout.write(lines.join('\n') + '\n');
 return exitCode;
}
