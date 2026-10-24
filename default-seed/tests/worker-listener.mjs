import { cp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

// Tests start the final runtime on port 0 and consume its advertised address.
// Never probe a socket, close it and pass the unowned number to another process.
export function advertisedOrigin(output, label = 'Ready on') {
  const plain = stripVTControlCharacters(output)
  const match = plain.match(new RegExp(`${label}\\s+(http://127\\.0\\.0\\.1:[1-9]\\d*)(?:/|\\s|$)`))
  return match?.[1]
}

// Test-only adapter around the real Worker. A :0 origin is a startup marker;
// once the runtime owns its socket, its request URL supplies the actual port.
// Keep the configured protocol/hostname and explicit Host headers, so tests
// still exercise application origin and Host admission rather than bypass it.
export function listenerEntry(specifier) {
  return `import worker from ${JSON.stringify(specifier)};
export default { ...worker, fetch(request, env, execution) {
  if (env.AUTH_ORIGIN && new URL(env.AUTH_ORIGIN).port === '0') {
    const origin = new URL(env.AUTH_ORIGIN);
    origin.port = new URL(request.url).port;
    env.AUTH_ORIGIN = origin.origin;
  }
  const headers = new Headers(request.headers);
  if (!headers.has('host')) headers.set('host', new URL(request.url).host);
  return worker.fetch(new Request(request, { headers }), env, execution);
} };`
}

// Preserve Wrangler's emitted no_bundle/module-discovery behavior in a disposable
// copy. The real CLI, workerd, assets and persisted D1 remain under test.
export async function listenerConfig(configPath, directory) {
  const source = dirname(configPath)
  const target = join(directory, 'worker')
  await cp(source, target, { recursive: true })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(join(target, 'test-listener.mjs'), listenerEntry('./' + config.main))
  config.main = 'test-listener.mjs'
  if (config.assets?.directory) config.assets.directory = resolve(source, config.assets.directory)
  for (const database of config.d1_databases ?? []) {
    if (database.migrations_dir) database.migrations_dir = resolve(source, database.migrations_dir)
  }
  const path = join(target, 'wrangler.json')
  await writeFile(path, JSON.stringify(config))
  return path
}
