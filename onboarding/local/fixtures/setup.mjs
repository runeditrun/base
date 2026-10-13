// Test-only historical runner fixture; never exported as an operating command.
import { loadInstallerSeed } from '../../setup-manifest.mjs'
import { createRedaction, credentialValues } from '../../redaction.mjs'
import { randomBytes } from 'node:crypto'
import { linkSync, unlinkSync } from 'node:fs'
import { link, lstat, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertRegular, inspect, privateDirectory, privateFile } from '../files.mjs'
import { localOptions, localOptionsOrigin } from './options.mjs'
import { buildEnvironment, localOrigin, localVariables, secretValues } from '../environment.mjs'
import { runCommand } from './command.mjs'
import { localOperation } from '../operation.mjs'
import { recoverInterrupted } from '../recovery.mjs'

// `node scripts/local-setup.mjs`: build, apply every local D1 migration, read the owner
// claim ledger and publish private credentials. A rerun keeps the exact
// existing .dev.vars; --force rotates it and keeps the old file as
// .dev.vars.previous. Failures restore the prior file.
export async function runLocalSetup(root, { args = process.argv.slice(2), parseAddress, command = 'node scripts/local-setup.mjs', devCommand = 'node scripts/local-dev.mjs', database, persistTo = '.wrangler/reference', wranglerConfig = 'dist/server/wrangler.json', manifestFile = 'rer-setup.json' } = {}) {
  let logPath
  let oldVars
  let varsPath
  let log
  let phase = 'validation'
  let pendingWrites = Promise.resolve()
  let logError
  let operation
  const redaction = createRedaction()
  redaction.addSecrets(secretValues(process.env))
  const cancellation = new AbortController()
  const cancel = (signal) => {
    const error = new Error(`Cancelled by ${signal}.`)
    error.signal = signal
    cancellation.abort(error)
  }
  const onInterrupt = () => cancel('SIGINT')
  const onTerminate = () => cancel('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  try {
    if (typeof database !== 'string' || !database) throw new TypeError('Provide the local D1 database name.')
    const seed = await loadInstallerSeed(root,{product:'Local setup',setup:{manifestFile},install:async()=>{}})
    const manifest = seed.manifest
    const secretNames = manifest.fields.filter(field => field.kind === 'secret').map(field => field.name)
    // The kit's validated navigation origin is public unless the manifest
    // explicitly makes that binding private. Keep it usable in status output.
    const privateValues = vars => credentialValues(Object.fromEntries(Object.entries(vars).filter(([name]) => name !== 'AUTH_ORIGIN' || secretNames.includes(name))), secretNames)
    const inheritedSecrets = secretNames.map(name => process.env[name]).filter(Boolean)
    redaction.addSecrets(inheritedSecrets)
    const claim = manifest.steps.find(step=>step.type==='owner-claim')
    if(claim?.mode!=='setup-token'||!claim.tokenField)throw Error(`${manifestFile}: local operator-auth setup needs a setup-token owner step with tokenField.`)
    const emailField=claim.emailField, tokenField=claim.tokenField
    varsPath = join(root, '.dev.vars')
    // Restore a hard-killed run's original before deciding to create new values.
    operation = await recoverInterrupted(root)
    const existing = await inspect(varsPath)
    assertRegular(existing)
    const original = existing ? await readFile(varsPath) : undefined
    const previous = original === undefined ? {} : localVariables(original.toString('utf8'))
    redaction.addSecrets(privateValues(previous))
    const options = await localOptions(args, root, previous, { parseAddress, usage: command, emailField })
    if (existing && !options.force) {
      options.origin = localOrigin(previous).origin
      const ignored = [
        options.given.has('--owner-email') && options.email !== previous[emailField]?.trim().toLowerCase() && '--owner-email',
        options.given.has('--port') && options.origin !== localOptionsOrigin(options.port) && '--port',
      ].filter(Boolean)
      if (ignored.length) console.warn(`Kept the existing .dev.vars settings; ${ignored.join(' and ')} ${ignored.length > 1 ? 'apply' : 'applies'} only with --force.`)
    }
    const backupPath = join(root, '.dev.vars.previous')
    if (existing && options.force && await inspect(backupPath)) {
      throw new Error('.dev.vars.previous already exists; move it to a private location before using --force again.')
    }
    cancellation.signal.throwIfAborted()
    const output = join(root, '.wrangler/local-setup')
    await privateDirectory(root, output)
    // Persistence must not escape through a pre-existing symlink either.
    await privateDirectory(root, join(root, persistTo))
    operation ??= await localOperation(root)
    const work = await mkdtemp(join(output, 'run-'))
    logPath = join(work, 'commands.log')
    log = await open(logPath, 'wx', 0o600)
    const write = (text) => {
      const safe = redaction.redact(text)
      pendingWrites = pendingWrites.then(() => { if (!logError) return log.writeFile(safe) })
        .catch(() => { logError = true })
    }
    // The Vite plugin copies .dev.vars into emitted assets. Hide the old file
    // for the build and migrations, and restore it exactly on a normal rerun.
    if (existing) {
      const status = await lstat(varsPath)
      if (status.ino !== existing.ino || status.dev !== existing.dev) throw new Error('.dev.vars changed during setup; run again.')
      const hiddenPath = join(work, 'previous.dev.vars')
      await rename(varsPath, hiddenPath)
      oldVars = hiddenPath
    }
    const env = buildEnvironment(manifest.fields.map(field => field.name))
    env.RER_LOCAL_OPERATION = operation.token
    const secrets = [...secretValues(previous), ...privateValues(previous), ...inheritedSecrets]
    const pnpm = async (args) => {
      cancellation.signal.throwIfAborted()
      write(`pnpm ${args.join(' ')}\n`)
      let stdout = ''
      await runCommand('pnpm', args, { cwd: root, env, write, secrets, signal: cancellation.signal, stdout: (text) => { stdout += text } })
      await pendingWrites
      cancellation.signal.throwIfAborted()
      if (logError) throw new Error('Could not write the private command log.')
      return stdout
    }
    console.log(redaction.redact('Building the Worker and applying all local migrations…'))
    phase = 'build'
    await pnpm(['build'])
    phase = 'local migrations'
    await pnpm(['exec', 'wrangler', 'd1', 'migrations', 'apply', database, '--local', '--persist-to', persistTo, '--config', wranglerConfig])
    phase = 'owner claim check'
    const ledger = JSON.parse(await pnpm(['exec', 'wrangler', 'd1', 'execute', database, '--local', '--persist-to', persistTo, '--config', wranglerConfig, '--command', 'SELECT COUNT(*) AS claimed FROM oa_bootstrap', '--json']))
    const claimed = ledger?.[0]?.results?.[0]?.claimed
    if (![0, 1].includes(claimed)) throw new Error('Could not read the local owner claim ledger.')
    phase = 'credential creation'
    let nextVars
    if (!existing || options.force) {
      const values={AUTH_LOCAL:'true',AUTH_ORIGIN:options.origin,MAIL_PROVIDER:'development',MAIL_FROM:'auth@localhost.test'}
      for(const field of manifest.fields){
        if(field.kind==='secret'&&field.generate)values[field.name]=randomBytes(32).toString(field.generate)
        else if(field.kind!=='secret'&&field.default!==undefined)values[field.name]=field.default
      }
      values[emailField]=options.email
      redaction.addSecrets(privateValues(values))
      const quoted=value=>/^[A-Za-z0-9.!_%@:/+=,-]*$/.test(value)?value:JSON.stringify(value)
      const content=Object.entries(values).map(([key,value])=>`${key}=${quoted(value)}`).join('\n')+'\n'
      nextVars = join(work, 'next.dev.vars')
      await privateFile(nextVars, content)
    }
    await log.close()
    log = undefined
    cancellation.signal.throwIfAborted()
    // Commit without an asynchronous gap. Every publication uses an exclusive
    // link: a concurrent credential or backup file is never replaced.
    if (oldVars && !options.force) {
      linkSync(oldVars, varsPath)
      unlinkSync(oldVars)
      oldVars = undefined
    } else {
      if (oldVars) {
        // Preserve the old inode privately until new credentials are published,
        // so a failed commit can still restore its exact mode and contents.
        const backup = join(work, 'backup.dev.vars')
        await privateFile(backup, original)
        cancellation.signal.throwIfAborted()
        linkSync(backup, backupPath)
        unlinkSync(backup)
      }
      linkSync(nextVars, varsPath)
      unlinkSync(nextVars)
      if (oldVars) { unlinkSync(oldVars); oldVars = undefined }
    }
    if (existing && options.force) console.log(redaction.redact(`Previous credentials saved privately: ${backupPath}`))
    const nextStep = claimed ? 'Owner already claimed. Use Email a sign-in link.'
      : (!existing || options.force || previous[tokenField]) ? `Use Set up the first owner; ${tokenField} is in .dev.vars.`
        : `No owner is claimed and ${tokenField} is missing. Run ${command} --force to create a setup credential.`
    console.log(redaction.redact(`Local setup ready. Private command log: ${logPath}\n${nextStep}\nNext: ${devCommand}\nOpen: ${options.origin}/signin`))
  } catch (error) {
    if (oldVars) {
      // Never overwrite a file created concurrently while the build ran.
      try {
        await link(oldVars, varsPath)
        await rm(oldVars)
        oldVars = undefined
      } catch { /* Keep the original privately if recovery cannot claim the path. */ }
    }
    console.error(redaction.redact(`Local setup failed during ${phase}: ${error.message}${logPath ? `\nPrivate command log: ${logPath}` : ''}${oldVars ? '\nOriginal .dev.vars retained privately beside the log; restore it after resolving the conflicting file.' : ''}`))
    process.exitCode = 1
  } finally {
    await pendingWrites
    try { await log?.close() } catch {
      console.error('Could not close the private command log.')
      process.exitCode = 1
    }
    await operation?.release()
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
}
