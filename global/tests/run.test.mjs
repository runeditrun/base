// rer run through the installed command's door: a project's documented
// `pnpm run X -- ARGS` works as `rer run X -- ARGS` with no pnpm on PATH.
// Only the npm registry is a fixture, serving a pnpm release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { run } from './harness.mjs';

const rer = resolve(import.meta.dirname, '../rer.mjs'), execute = promisify(execFile);

test('rer run runs a package script with the pnpm the checkout pins, fetched into rer\'s cache, when PATH has no pnpm', { timeout: 60000 }, async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-run-'))), home = join(directory, 'home'), bin = join(directory, 'bin'), checkout = join(directory, 'app');
 t.after(() => rm(directory, { recursive: true, force: true }));
 const pin = '10.99.1';
 // The release's pnpm answers --version and runs a script as pnpm run does: its args follow it.
 const release = join(directory, 'release/package');
 await mkdir(join(release, 'bin'), { recursive: true });
 await writeFile(join(release, 'package.json'), JSON.stringify({ name: 'pnpm', version: pin }));
 await writeFile(join(release, 'bin/pnpm.cjs'), `const [verb, ...rest] = process.argv.slice(2), silent = rest[0] === '--silent', [name, ...args] = silent ? rest.slice(1) : rest;
if (verb === '--version') { console.log(${JSON.stringify(pin)}); process.exit(0); }
const script = require(process.cwd() + '/package.json').scripts[name];
if (!silent) console.log('> app@1.0.0 ' + name);
process.exit(require('node:child_process').spawnSync('/bin/sh', ['-c', script + ' "$@"', name, ...args], { stdio: 'inherit' }).status);
`);
 const archive = join(directory, 'pnpm.tgz');
 await execute('tar', ['-czf', archive, '-C', join(directory, 'release'), 'package']);
 const integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
 const edge = join(directory, 'edge.mjs');
 await writeFile(edge, `import { readFileSync } from 'node:fs';
globalThis.fetch = async url => new Response(String(url).endsWith('.tgz') ? readFileSync(${JSON.stringify(archive)}) : JSON.stringify({ version: ${JSON.stringify(pin)}, dist: { integrity: ${JSON.stringify(integrity)} } }));
`);

 await Promise.all([mkdir(home), mkdir(bin), mkdir(join(checkout, 'nested'), { recursive: true })]);
 for (const tool of ['tar', 'gzip']) await symlink((await execute('/bin/sh', ['-c', `command -v ${tool}`])).stdout.trim(), join(bin, tool));
 await symlink(process.execPath, join(bin, 'node'));
 await writeFile(join(checkout, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/run', seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' } }));
 await writeFile(join(checkout, '.node-version'), process.versions.node + '\n');
 await writeFile(join(checkout, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: `pnpm@${pin}`, scripts: { 'export:data': 'echo "exported to $PWD with"', fails: 'exit 7' } }));
 const env = { HOME: home, PATH: bin, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${pathToFileURL(edge).href}` };
 assert.notEqual((await run('/bin/sh', ['-c', 'command -v pnpm'], { env })).code, 0, 'no pnpm on PATH');

 const result = await run(process.execPath, [rer, 'run', 'export:data', '--', '--remote', '--out', 'x'], { cwd: join(checkout, 'nested'), env });
 assert.equal(result.code, 0, result.stderr);
 assert.match(result.stdout, new RegExp(`exported to ${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} with -- --remote --out x`));
 assert.doesNotMatch(result.stdout, /^> /m, 'no pnpm banner naming the package');
 await access(join(home, '.rer/pnpm', `pnpm-${pin}`));

 const outside = await run(process.execPath, [rer, 'run', 'export:data'], { cwd: directory, env });
 assert.equal(outside.code, 2, 'outside a checkout it names where it runs');
 const missingScript = await run(process.execPath, [rer, 'run', 'hosted-backup', '--', '--remote'], { cwd: join(checkout, 'nested'), env });
 assert.equal(missingScript.code, 2, missingScript.stdout + missingScript.stderr);
 assert.equal(missingScript.stderr.trim(), 'No script named hosted-backup in this checkout. Scripts: export:data, fails');
 assert.equal(missingScript.stdout, '');
 assert.equal((await run(process.execPath, [rer, 'run', 'fails'], { cwd: join(checkout, 'nested'), env })).code, 7, 'a script that exists keeps its own exit code');
 // A different pnpm earlier on the caller's PATH must not replace the pin,
 // while tools that the package script runs keep the caller's ordering.
 await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.0.0; else exit 91; fi\n', { mode: 0o755 });
 await writeFile(join(bin, 'npm'), '#!/bin/sh\necho caller-tool-ran\n', { mode: 0o755 });
 await writeFile(join(checkout, 'package.json'), JSON.stringify({ packageManager: `pnpm@${pin}`, scripts: { check: 'npm' } }));
 const callerPath = await run(process.execPath, [rer, 'run', 'check'], { cwd: checkout, env });
 assert.equal(callerPath.code, 0, callerPath.stderr);
 assert.match(callerPath.stdout, /caller-tool-ran/);

});
