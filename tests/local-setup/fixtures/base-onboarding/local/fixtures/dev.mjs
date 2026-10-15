// Test-only historical runner fixture; never exported as an operating command.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localOrigin, localVariables, secretValues } from '../environment.mjs'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { assertRegular, inspect, privateDirectory } from '../files.mjs'
import { redact } from './command.mjs'
import { recoverInterrupted } from '../recovery.mjs'

// `node scripts/local-dev.mjs`: recover an interrupted build, check the private bindings
// and serve the built Worker on its loopback origin with only those bindings.
export async function runLocalDev(root, { setupCommand = 'node scripts/local-setup.mjs', devCommand = 'node scripts/local-dev.mjs', persistTo = '.wrangler/reference', wranglerConfig = 'dist/server/wrangler.json' } = {}) {
  try {
    const path = join(root, '.dev.vars')
    // Recover from a hard-killed build or setup; wait out a running one.
    await (await recoverInterrupted(root))?.release()
    const status = await inspect(path)
    assertRegular(status)
    if (!status) throw new Error(`Run ${setupCommand} first.`)
    const vars = localVariables(await readFile(path, 'utf8'))
    for (const key of ['OWNER_EMAIL', 'SESSION_SECRET']) {
      if (!vars[key]?.trim()) throw new Error(`${key} is missing or empty in .dev.vars. Restore it from your private backup or run ${setupCommand} --force.`)
    }
    const url = localOrigin(vars)
    const port = url.port || '80'
    await privateDirectory(root, join(root, persistTo))
    // Wrangler's explicit --env-file uses its dotenv loader, even for .dev.vars.
    // Enable that loader while excluding inherited process variables as bindings.
    const child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--inspector-port', '0', '--config', wranglerConfig, '--env-file', path, '--local', '--persist-to', persistTo, '--ip', '127.0.0.1', '--port', port, '--show-interactive-dev-session=false'], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' } })
    const secrets = secretValues(vars)
    // Wrangler reports a busy port as a Node stack dump on stderr. Hold stderr
    // until the Worker is ready (or exits) so that case becomes one plain line.
    let ready = false
    let held = ''
    const lines = (stream, emit) => {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      stream.on('data', (chunk) => {
        pending += decoder.write(chunk)
        const end = pending.lastIndexOf('\n')
        if (end >= 0) { emit(redact(pending.slice(0, end + 1), secrets)); pending = pending.slice(end + 1) }
      })
      stream.on('end', () => emit(redact(pending + decoder.end(), secrets)))
    }
    lines(child.stdout, (text) => {
      process.stdout.write(text)
      if (!ready && /Ready on /.test(text)) { ready = true; process.stderr.write(held); held = '' }
    })
    lines(child.stderr, (text) => { if (ready) process.stderr.write(text); else held += text })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
    child.on('error', () => { console.error('Could not start pnpm; install dependencies first.'); process.exitCode = 1 })
    child.on('close', (code) => {
      process.exitCode = code ?? 1
      if (/EADDRINUSE|address already in use/i.test(held)) console.error(`Port ${port} is in use. Stop the other local server, then run ${devCommand} again.`)
      else process.stderr.write(held)
    })
  } catch (error) {
    console.error(`Local development failed: ${error.message}`)
    process.exitCode = 1
  }
}
