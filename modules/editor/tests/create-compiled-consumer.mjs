/** Add nonempty test-only compiled input and application HTTP CSP to a fresh native consumer. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiledSnapshot } from './compiled-consumer-data.mjs';
const output = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Pass a new consumer directory');
execFileSync(process.execPath, [fileURLToPath(new URL('create-consumer.mjs', import.meta.url)), output], { stdio: 'inherit' });
const base = fileURLToPath(new URL('../../..', import.meta.url));
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  writeFileSync(join(output, file), execFileSync('git', ['show', `HEAD:${file}`], { cwd: base }));
}
// The root lockfile pins the patches the root package.json lists, so the consumer carries them too.
for (const patch of Object.values(JSON.parse(readFileSync(join(output, 'package.json'), 'utf8')).pnpm?.patchedDependencies ?? {})) {
  mkdirSync(dirname(join(output, patch)), { recursive: true });
  writeFileSync(join(output, patch), execFileSync('git', ['show', `HEAD:${patch}`], { cwd: base }));
}
const seed = join(output, 'default-seed');
writeFileSync(join(seed, 'src/editor/visual-edits.json'), JSON.stringify(compiledSnapshot, null, 2) + '\n');
const file = join(seed, 'src/server.ts');
let source = readFileSync(file, 'utf8');
const marker = '    return dispatch(request,';
if (!source.includes(marker)) throw new Error('Native response dispatcher changed');
source = "import { parseConfig } from './editor/config'\n" + source.replace(marker, '    const response = await dispatch(request,');
const end = '    })\n  },';
if (!source.includes(end)) throw new Error('Native document dispatcher end changed');
source = source.replace(end, `    })
    // Merge with an existing adopter policy; this fresh reference has none.
    const settings = bindings as Bindings & { EDITOR_MANAGEMENT_ORIGIN?: string; EDITOR_INSTALLATION_ID?: string }
    if (!settings.EDITOR_MANAGEMENT_ORIGIN || !settings.EDITOR_INSTALLATION_ID) return response
    const config = parseConfig({ enabled: true, managementOrigin: settings.EDITOR_MANAGEMENT_ORIGIN, installationId: settings.EDITOR_INSTALLATION_ID })
    if (response.headers.has('content-security-policy')) throw new Error('Integrate the editor with the existing application CSP')
    const headers = new Headers(response.headers)
    headers.set('content-security-policy', "base-uri 'self'; object-src 'none'; frame-src 'self' " + config.managementOrigin)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },`);
writeFileSync(file, source);
const sourceRecord = JSON.parse(readFileSync(join(output, 'SOURCE.json'), 'utf8'));
sourceRecord.compiledEdits = 'nonempty test-only snapshot covering four regular native leaves and the native NotFound component';
sourceRecord.applicationCsp = 'HTTP frame-src exact validated management origin; no existing application policy replaced';
sourceRecord.generator = 'modules/editor/tests/create-compiled-consumer.mjs';
writeFileSync(join(output, 'SOURCE.json'), JSON.stringify(sourceRecord, null, 2) + '\n');
execFileSync('git', ['add', '.'], { cwd: output });
execFileSync('git', ['-c', 'user.name=Local test consumer', '-c', 'user.email=consumer@example.test', 'commit', '-m', 'Exercise nonempty compiled edits and application framing policy'], { cwd: output, stdio: 'inherit' });
console.log(JSON.stringify({ output, generatorDirectory: dirname(fileURLToPath(import.meta.url)), consumerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: output, encoding: 'utf8' }).trim() }));
