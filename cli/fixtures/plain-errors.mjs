import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { run } from '../../global/tests/harness.mjs';
import { stepFailureText } from '../../onboarding/step-failure.mjs';

// Exercise installed package bytes, with no inherited environment or credentials.
export async function plainErrors(t, base) {
 const directory = await mkdtemp(join(tmpdir(), 'rer-plain-')), root = join(directory, 'seed'), home = join(directory, 'home');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await mkdir(join(root, 'scripts'), { recursive: true });
 await mkdir(home);
 const packed = await buildPackage(base, join(directory, 'built'));
 assert.equal((await run('tar', ['-xzf', packed, '-C', directory])).code, 0);
 const pkg = join(directory, 'package'), entry = join(pkg, 'global/rer.mjs');
 await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-base-1', type: 'module', packageManager: 'pnpm@10.12.4', engines: { node: process.versions.node }, dependencies: { pako: '1.0.11' } }));
 await writeFile(join(root, '.node-version'), process.versions.node);
 await writeFile(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      pako:
        specifier: 1.0.11
        version: 1.0.11
packages:
  pako@1.0.11:
    resolution: {tarball: http://127.0.0.1:9/pako/-/pako-1.0.11.tgz}
snapshots:
  pako@1.0.11: {}
`);
 const source = path => JSON.stringify(new URL(path, `file://${pkg}/`).href);
 await writeFile(join(root, 'scripts/rer.mjs'), `import {main} from ${source('cli/main.mjs')}; process.exitCode=await main();`);
 await writeFile(join(root, 'adapter.mjs'), `import {localInstaller} from ${source('onboarding/adapter.mjs')}; import {commandAdapter as declare} from ${source('cli/adapter.mjs')}; export const commandAdapter=declare(localInstaller({}),{portability:{import:async()=>({}),export:async()=>({})}});`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'synthetic-base-1', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(['install', 'dev', 'import'].map(verb => [verb, { argv: ['node', 'adapter.mjs'], inputs: [], effects: 'Synthetic diagnostic.' }])) }));
 const invoke = (args, executable = entry) => run('env', ['-i', `PATH=${process.env.PATH}`, `HOME=${home}`, `RER_JOBS_DIR=${join(directory, 'queue')}`, 'RER_NO_UPDATE_CHECK=1', 'npm_config_fetch_retries=0', process.execPath, executable, ...args, '--cwd', root], { cwd: root });
 const human = async (args, code, expected) => {
  const result = await invoke(args);
  t.diagnostic(`${args.join(' ')}: exit ${result.code}\n${result.stdout}${result.stderr}`);
  assert.equal(result.code, code);
  assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stdout + result.stderr, /FetchError|RerError|TypeError|\n\s+at /);
  return result;
 };
 await human(['dev', '--port', '99999'], 2, /Port "99999" is invalid\. Use a port from 1 to 65535, for example: rer dev --port 4800/);
 const port = await invoke(['dev', '--port', '99999', '--json']);
 assert.equal(port.code, 2);
 assert.equal(port.stdout, '');
 assert.equal(port.stderr, 'Port must be a decimal integer from 1 to 65535.\n');
 const direct = await invoke(['dev', '--port', '99999'], join(pkg, 'bin/rer.mjs'));
 assert.equal(direct.code, 2);
 assert.match(direct.stderr, /Port \"99999\" is invalid[\s\S]*rer dev --port 4800/);
 const directData = await invoke(['dev', '--port', '99999', '--json'], join(pkg, 'bin/rer.mjs'));
 assert.equal(directData.code, 2);
 assert.equal(directData.stdout, JSON.stringify({version:1,verb:'dev',event:'error',code:'invalid_invocation',message:'Port must be a decimal integer from 1 to 65535.',exitCode:2})+'\n'+JSON.stringify({version:1,verb:'dev',event:'result',ok:false,exitCode:2})+'\n');
 const args = ['import', '--input', '../old.rer', '--journal', '../latest.rer', '--yes'];
 await human(args, 4, /--input "\.\.\/old\.rer" must stay inside this checkout[\s\S]*\.rer\/recovery\/<name>\.rer[\s\S]*rer import --input '\.rer\/recovery\/old\.rer' --journal '\.rer\/recovery\/latest\.rer' --yes/);
 const machine = await invoke([...args, '--json']);
 assert.equal(machine.code, 4);
 assert.equal(machine.stdout, JSON.stringify({ version: 1, verb: 'import', event: 'error', code: 'safety_refusal', message: 'Path must be a contained checkout path without traversal.', exitCode: 4 }) + '\n' + JSON.stringify({ version: 1, verb: 'import', event: 'result', ok: false, exitCode: 4 }) + '\n');
 await mkdir(join(root, '.rer/recovery'), { recursive: true });
 await writeFile(join(root, '.rer/recovery/old.rer'), '', { mode: 0o600 });
 const journal = await human(['import', '--input', '.rer/recovery/old.rer', '--journal', '../latest.rer', '--yes'], 4, /--journal "\.\.\/latest\.rer" must stay inside this checkout/);
 assert.match(journal.stderr, /--input '\.rer\/recovery\/old\.rer' --journal '\.rer\/recovery\/latest\.rer'/);
 await human(['dev'], 1, /Could not download a dependency \(pako 1\.0\.11\) because the package registry at 127\.0\.0\.1:9 refused the connection\. Check your network or registry setting, then run: rer dev --cwd '/);
 const download = await invoke(['dev', '--json']);
 assert.equal(download.code, 1);
 const lines = download.stdout.trim().split('\n'), errorLine = lines.find(line => JSON.parse(line).event === 'error'), error = JSON.parse(errorLine);
 assert.equal(error.code, 'install_step_failed');
 assert.ok(error.step.output.some(line => line.includes('FetchError')));
 assert.ok(error.step.output.some(line => /^\s+at /.test(line)));
 const message = `${stepFailureText(error.step)}\nCorrect the cause, then run rer dev --cwd '${root}' again.`;
 assert.equal(errorLine, JSON.stringify({ version: 1, verb: 'install', event: 'error', code: 'install_step_failed', message, exitCode: 1, step: error.step }));
 assert.equal(lines.at(-1), JSON.stringify({ version: 1, verb: 'dev', event: 'result', ok: false, exitCode: 1 }));
 assert.match(await readFile(join(root, error.step.log), 'utf8'), /FetchError/);
}
