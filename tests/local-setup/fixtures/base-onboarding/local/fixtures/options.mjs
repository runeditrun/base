// Test-only historical runner fixture; never exported as an operating command.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// `parseAddress` is the caller's delivery validator (Base modules/mail
// parseAddress); onboarding stays dependency-free when copied into a seed.
export async function localOptions(args, root, previous = {}, { parseAddress, usage = 'node scripts/local-setup.mjs', emailField = 'OWNER_EMAIL' } = {}) {
  if (typeof parseAddress !== 'function') throw new TypeError('Provide the mail address validator.')
  let previousPort
  try { previousPort = previous.AUTH_ORIGIN ? new URL(previous.AUTH_ORIGIN).port || '80' : undefined } catch { /* Explicit force options can repair an invalid origin. */ }
  const options = { port: previousPort ?? '8787', email: previous[emailField], force: false, given: new Set() }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--') continue // a package script also passes -- --port …
    if (flag === '--force') { options.force = true; continue }
    if (!['--owner-email', '--port'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`Use ${usage} [--owner-email EMAIL] [--port PORT] [--force].`)
    }
    options.given.add(flag)
    options[flag === '--port' ? 'port' : 'email'] = args[++i]
  }
  if (options.email === undefined) {
    try {
      const { stdout } = await promisify(execFile)('git', ['config', 'user.email'], { cwd: root })
      options.email = stdout.trim()
    } catch { /* The actionable error below also handles an unset git identity. */ }
  }
  if (!options.email) throw new Error(`No owner email found. Run ${usage} --owner-email EMAIL.`)
  try {
    // Use the delivery validator, with a narrower dotenv-safe plain mailbox.
    const address = parseAddress(options.email)
    if (address.name || address.email !== options.email ||
        !/^[a-zA-Z0-9.!+_%\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)+$/.test(options.email)) {
      throw new Error('Invalid plain mailbox')
    }
  } catch {
    throw new Error('Invalid --owner-email; provide a plain email address.')
  }
  if (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) {
    throw new Error('Invalid --port; use an integer from 1 to 65535.')
  }
  options.email = options.email.toLowerCase()
  options.port = String(Number(options.port))
  options.origin = localOptionsOrigin(options.port)
  return options
}

export const localOptionsOrigin = (port) => new URL(`http://127.0.0.1:${port}`).origin
