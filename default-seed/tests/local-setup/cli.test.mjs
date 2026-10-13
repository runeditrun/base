import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { localOperation } from '../../scripts/base-onboarding/local/operation.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const execute = promisify(execFile)

async function fixture(t) {
  const parent = join(root, '.wrangler/local-setup-tests')
  await mkdir(parent, { recursive: true })
  const sandbox = await mkdtemp(join(parent, 'run-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const dir = join(sandbox, 'default-seed')
  await mkdir(dir)
  await cp(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
  await cp(join(root, 'tests/local-setup/fixtures'), join(dir, 'scripts'), { recursive: true })

  await cp(join(root, 'rer-setup.json'), join(dir, 'rer-setup.json'))
  await mkdir(join(dir, 'bin'))
  // Application code always runs actual commands. Only this fixture replaces
  // pnpm/git to prove CLI behavior cheaply without another build/workerd job.
  const mock = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]);
if(command === 'git') { console.log(process.env.TEST_EMAIL ?? 'owner@example.test'); process.exit(0); }
appendFileSync(join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args:process.argv.slice(2), varsPresent:(()=>{try{readFileSync('.dev.vars');return true}catch{return false}})(), authEnv:process.env.SESSION_SECRET, loadDevVars:process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, includeProcessEnv:process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV })+'\\n');
if(process.env.TEST_DEV_ECHO){ const text=readFileSync('.dev.vars','utf8'); process.stdout.write(text); process.stderr.write(text); }
if(process.env.TEST_FAIL && process.argv.includes(process.env.TEST_FAIL)){ console.error('private child diagnostic'); process.exit(9); }
if(process.env.TEST_PORT_BUSY){ console.log('wrangler banner'); console.error('node:events:505\\n    throw er; // Unhandled error event\\nError: listen EADDRINUSE: address already in use 127.0.0.1:'+process.env.TEST_PORT_BUSY+'\\n    at Server.setupListenHandle [as _listen2] (node:net:2328:16)\\nkj/async-io-unix.c++: Address already in use'); process.exit(1); }
if(process.argv.includes('--json')) console.log(JSON.stringify([{results:[{claimed:Number(process.env.TEST_CLAIMED ?? 0)}]}]));
else console.log('child output');
`
  for (const name of ['git', 'pnpm']) {
    const path = join(dir, 'bin', name)
    await writeFile(path, mock)
    await chmod(path, 0o700)
  }
  // mock executables are ES modules even without the app's package.json
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  return { dir, run: async (args = [], env = {}, script = 'local-setup') => {
    try {
      const result = await execute(process.execPath, [join(dir, `scripts/${script}.mjs`), ...args], { cwd: dir, env: { ...process.env, RER_LOCAL_OPERATION: '', ...env, PATH: `${join(dir, 'bin')}:${env.PATH ?? process.env.PATH}` } })
      return { code: 0, ...result }
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
  } }
}

const parse = (text) => Object.fromEntries(text.trim().split('\n').map((line) => line.split('=')))
async function calls(dir) { return (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) }
async function log(dir) {
  const output = join(dir, '.wrangler/local-setup')
  const runs = await readdir(output)
  const path = join(output, runs.at(-1), 'commands.log')
  return { text: await readFile(path, 'utf8'), path }
}

test('git email/default port, private fresh credentials, real command arguments and concise next step', async (t) => {
  const { dir, run } = await fixture(t)
  const result = await run([], { SESSION_SECRET: 'parent-value-must-not-enter-build' })
  assert.equal(result.code, 0, result.stderr)
  const raw = await readFile(join(dir, '.dev.vars'), 'utf8')
  const vars = parse(raw)
  assert.equal(vars.OWNER_EMAIL, 'owner@example.test')
  assert.equal(vars.AUTH_ORIGIN, 'http://127.0.0.1:8787')
  assert.equal(vars.AUTH_LOCAL, 'true')
  assert.equal(vars.MAIL_PROVIDER, 'development')
  assert.equal(vars.MAIL_FROM, 'auth@localhost.test')
  assert.match(vars.SESSION_SECRET, /^[a-f0-9]{64}$/)
  assert.match(vars.SETUP_TOKEN, /^[a-f0-9]{64}$/)
  assert.notEqual(vars.SESSION_SECRET, vars.SETUP_TOKEN)
  assert.equal((await stat(join(dir, '.dev.vars'))).mode & 0o777, 0o600)
  const commands = await calls(dir)
  assert.deepEqual(commands.map((item) => item.args), [ ['build'], ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'default-seed-reference', '--local', '--persist-to', '.wrangler/reference', '--config', 'dist/server/wrangler.json'], ['exec', 'wrangler', 'd1', 'execute', 'default-seed-reference', '--local', '--persist-to', '.wrangler/reference', '--config', 'dist/server/wrangler.json', '--command', 'SELECT COUNT(*) AS claimed FROM oa_bootstrap', '--json'] ])
  assert.ok(commands.every((item) => !item.varsPresent && !item.authEnv))
  const logs = await log(dir)
  assert.equal((await stat(logs.path)).mode & 0o777, 0o600)
  assert.match(logs.text, /child output/)
  assert.ok(result.stdout.includes(logs.path))
  assert.match(result.stdout, /Next: node scripts\/local-dev\.mjs\nOpen: http:\/\/127\.0\.0\.1:8787\/signin\n$/)
  assert.equal((result.stdout.match(/http:\/\//g) ?? []).length, 1)
  for (const secret of [vars.SESSION_SECRET, vars.SETUP_TOKEN]) assert.ok(!`${result.stdout}${result.stderr}${logs.text}`.includes(secret))
})

test('no email and invalid arguments name flags and create no partial output', async (t) => {
  const { dir, run } = await fixture(t)
  for (const [args, env, error] of [
    [[], { TEST_EMAIL: '' }, /--owner-email/],
    [['--owner-email', 'a@example.test\nSETUP_TOKEN=evil'], {}, /--owner-email/],
    [['--owner-email', 'a@example.test#comment'], {}, /--owner-email/],
    [['--owner-email', '"a"@example.test'], {}, /--owner-email/],
    [['--port', '0'], {}, /--port/],
    [['--port', '65536'], {}, /--port/],
    [['--port', '8787\nX=bad'], {}, /--port/],
    [['--unknown'], {}, /local-setup\.mjs/],
    [['--owner-email'], {}, /local-setup\.mjs/],
  ]) {
    const result = await run(args, env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, error)
  }
  await assert.rejects(stat(join(dir, '.dev.vars')), { code: 'ENOENT' })
  await assert.rejects(stat(join(dir, '.wrangler')), { code: 'ENOENT' })
  await assert.rejects(stat(join(dir, 'calls.jsonl')), { code: 'ENOENT' })
})

test('mail delivery rejects malformed owner addresses before any setup effects', async (t) => {
  const { dir, run } = await fixture(t)
  for (const email of [
    '.owner@example.test',
    'owner.@example.test',
    'owner..name@example.test',
    'owner@-example.test',
    'owner@example-.test',
    `${'a'.repeat(65)}@example.test`,
    `owner@${'a'.repeat(64)}.test`,
    'Owner <owner@example.test>',
    '<owner@example.test>',
  ]) {
    for (const [args, env] of [
      [['--owner-email', email], {}],
      [[], { TEST_EMAIL: email }],
    ]) {
      const result = await run(args, env)
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, 'Local setup failed during validation: Invalid --owner-email; provide a plain email address.\n')
      await assert.rejects(stat(join(dir, '.dev.vars')), { code: 'ENOENT' })
      await assert.rejects(stat(join(dir, '.wrangler')), { code: 'ENOENT' })
      await assert.rejects(stat(join(dir, 'calls.jsonl')), { code: 'ENOENT' })
    }
  }
})

test('malformed force input preserves existing credentials before any setup effects', async (t) => {
  const { dir, run } = await fixture(t)
  const path = join(dir, '.dev.vars')
  const original = 'OWNER_EMAIL=owner@example.test\nSESSION_SECRET=existing-private-value\n'
  await writeFile(path, original, { mode: 0o600 })
  const result = await run(['--force', '--owner-email', 'owner..name@example.test'])
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Local setup failed during validation: Invalid --owner-email; provide a plain email address.\n')
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await assert.rejects(stat(join(dir, '.wrangler')), { code: 'ENOENT' })
  await assert.rejects(stat(join(dir, 'calls.jsonl')), { code: 'ENOENT' })
})

test('valid boundary mailbox preserves dotenv-safe punctuation and normalizes case', async (t) => {
  const { dir, run } = await fixture(t)
  const email = `${'A'.repeat(57)}.!+_%Z-@Example.test`
  const result = await run(['--owner-email', email])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(parse(await readFile(join(dir, '.dev.vars'), 'utf8')).OWNER_EMAIL, email.toLowerCase())
})

test('overrides, rerun and force rotate both credentials without build-time exposure', async (t) => {
  const { dir, run } = await fixture(t)
  assert.equal((await run(['--owner-email', 'Other@Example.test', '--port', '08888'])).code, 0)
  const path = join(dir, '.dev.vars')
  const original = await readFile(path, 'utf8')
  const vars = parse(original)
  assert.equal(vars.OWNER_EMAIL, 'other@example.test')
  assert.equal(vars.AUTH_ORIGIN, 'http://127.0.0.1:8888')
  // An ordinary rerun rebuilds and migrates but keeps the existing file.
  const rerun = await run()
  assert.equal(rerun.code, 0, rerun.stderr)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal((await calls(dir)).length, 6)
  const forced = await run(['--force'])
  assert.equal(forced.code, 0, forced.stderr)
  const next = parse(await readFile(path, 'utf8'))
  assert.notEqual(next.SESSION_SECRET, vars.SESSION_SECRET)
  assert.notEqual(next.SETUP_TOKEN, vars.SETUP_TOKEN)
  assert.ok((await calls(dir)).every((item) => !item.varsPresent))
})

test('build and migration failures retain private diagnostics and restore exact old file', async (t) => {
  for (const phase of ['build', 'migrations']) {
    const { dir, run } = await fixture(t)
    const path = join(dir, '.dev.vars')
    const original = 'SESSION_SECRET=old-private-secret\nSETUP_TOKEN=old-private-token\n'
    await writeFile(path, original, { mode: 0o640 })
    const result = await run(['--force'], { TEST_FAIL: phase })
    assert.equal(result.code, 1)
    assert.match(result.stderr, phase === 'build' ? /during build/ : /during local migrations/)
    assert.ok(!result.stdout.includes('Local setup ready'))
    assert.ok(!result.stderr.includes('private child diagnostic'))
    assert.equal(await readFile(path, 'utf8'), original)
    assert.equal((await stat(path)).mode & 0o777, 0o640)
    const logs = await log(dir)
    assert.match(logs.text, /private child diagnostic/)
    assert.ok(result.stderr.includes(logs.path))
    assert.ok(!`${result.stdout}${result.stderr}${logs.text}`.includes('old-private-secret'))
    assert.equal((await calls(dir)).length, phase === 'build' ? 1 : 2)
  }
})

test('refuses secret-file and output symlinks even with force without touching targets', async (t) => {
  for (const link of ['.dev.vars', '.wrangler', '.wrangler/local-setup', '.wrangler/reference']) {
    const { dir, run } = await fixture(t)
    const target = join(dir, 'unrelated')
    if (link === '.dev.vars') await writeFile(target, 'keep private')
    else await mkdir(target)
    if (link.startsWith('.wrangler/')) await mkdir(join(dir, '.wrangler'))
    await symlink(target, join(dir, link))
    const result = await run(['--force'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Unsafe/)
    if (link === '.dev.vars') assert.equal(await readFile(target, 'utf8'), 'keep private')
    else assert.deepEqual(await readdir(target), [])
    await assert.rejects(stat(join(dir, 'calls.jsonl')), { code: 'ENOENT' })
  }
})

test('the dev fixture loads private dotenv bindings, excludes inherited bindings and redacts output', async (t) => {
  const { dir, run } = await fixture(t)
  assert.equal((await run(['--port', '8889'])).code, 0)
  const vars = parse(await readFile(join(dir, '.dev.vars'), 'utf8'))
  const result = await run([], { TEST_DEV_ECHO: '1', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true' }, 'local-dev')
  assert.equal(result.code, 0, result.stderr)
  const command = (await calls(dir)).at(-1)
  assert.equal(command.loadDevVars, 'true')
  assert.equal(command.includeProcessEnv, 'false')
  for (const secret of [vars.SESSION_SECRET, vars.SETUP_TOKEN]) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret))
  assert.match(result.stdout, /SESSION_SECRET=\[redacted\]/)
})

test('HTTP default port is canonicalized for auth and still starts on port 80', async (t) => {
  const { dir, run } = await fixture(t)
  const setup = await run(['--port', '80'])
  assert.equal(setup.code, 0, setup.stderr)
  assert.equal(parse(await readFile(join(dir, '.dev.vars'), 'utf8')).AUTH_ORIGIN, 'http://127.0.0.1')
  assert.match(setup.stdout, /Open: http:\/\/127\.0\.0\.1\/signin/)
  const dev = await run([], {}, 'local-dev')
  assert.equal(dev.code, 0, dev.stderr)
  const args = (await calls(dir)).at(-1).args
  assert.equal(args[args.indexOf('--port') + 1], '80')
})

test('a hard-linked secret file cannot overwrite an unrelated file', async (t) => {
  const { dir, run } = await fixture(t)
  const original = join(dir, 'unrelated')
  await writeFile(original, 'original credentials')
  await link(original, join(dir, '.dev.vars'))
  const result = await run(['--force'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /hard link/)
  assert.equal(await readFile(original, 'utf8'), 'original credentials')
  await assert.rejects(stat(join(dir, 'calls.jsonl')), { code: 'ENOENT' })
})

test('missing pnpm reports the build phase and leaves no credentials', async (t) => {
  const { dir, run } = await fixture(t)
  await rm(join(dir, 'bin/pnpm'))
  const result = await run(['--owner-email', 'owner@example.test'], { PATH: join(dir, 'nowhere') })
  // fixture prepends its own bin; without pnpm or a system path spawn fails.
  assert.equal(result.code, 1)
  assert.match(result.stderr, /during build: Could not start pnpm/)
  assert.ok(!result.stdout.includes('Local setup ready'))
  await assert.rejects(stat(join(dir, '.dev.vars')), { code: 'ENOENT' })
})


test('setup rerun preserves every byte, removed setup token and nondefault owner/origin while applying migrations', async (t) => {
  const { dir, run } = await fixture(t)
  assert.equal((await run(['--owner-email', 'original@example.test', '--port', '8893'])).code, 0)
  const path = join(dir, '.dev.vars')
  const original = (await readFile(path, 'utf8')).replace(/^SETUP_TOKEN=.*\n/m, '') + '# private extra settings\nCUSTOM_VALUE="keep = spaces"\n'
  await writeFile(path, original, { mode: 0o600 })
  const before = await stat(path)
  const result = await run(['--owner-email', 'ignored@example.test', '--port', '8989'], { TEST_EMAIL: '', TEST_CLAIMED: '1' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal((await stat(path)).ino, before.ino)
  assert.match(result.stdout, /Owner already claimed/)
  assert.doesNotMatch(result.stdout, /Use Set up the first owner/)
  assert.match(result.stdout, /Open: http:\/\/127\.0\.0\.1:8893\/signin/)
  assert.deepEqual((await calls(dir)).slice(-3).map(({args}) => args.includes('migrations') ? 'migrations' : args.includes('--json') ? 'ledger' : args[0]), ['build', 'migrations', 'ledger'])
})

test('force retains an exact private backup and refuses a subsequent backup collision', async (t) => {
  const { dir, run } = await fixture(t)
  assert.equal((await run()).code, 0)
  const path = join(dir, '.dev.vars')
  const original = await readFile(path)
  await chmod(path, 0o640)
  const forced = await run(['--force'])
  assert.equal(forced.code, 0, forced.stderr)
  const backup = join(dir, '.dev.vars.previous')
  assert.ok((await readFile(backup)).equals(original), 'backup bytes preserved')
  assert.equal((await stat(backup)).mode & 0o777, 0o600)
  assert.ok(forced.stdout.includes(backup))
  const next = await readFile(path)
  assert.equal((await run(['--force'])).code, 1)
  assert.ok((await readFile(path)).equals(next))
  assert.ok((await readFile(backup)).equals(original))
})

test('ordinary build excludes local credentials and restores the exact file after success and failure', async (t) => {
  for (const failure of ['', 'vite']) {
    const { dir, run } = await fixture(t)
    const path = join(dir, '.dev.vars')
    const original = '# retain comment\nSESSION_SECRET=unit-private-session\nSETUP_TOKEN=unit-private-setup\n'
    await writeFile(path, original, { mode: 0o640 })
    const before = await stat(path)
    const result = await run([], { TEST_FAIL: failure, SESSION_SECRET: 'inherited-build-secret' }, 'local-build')
    assert.equal(result.code, failure ? 1 : 0)
    assert.equal(await readFile(path, 'utf8'), original)
    const after = await stat(path)
    assert.equal(after.ino, before.ino)
    assert.equal(after.mode & 0o777, 0o640)
    assert.equal(after.nlink, 1)
    const [command] = await calls(dir)
    assert.deepEqual(command.args, ['exec', 'vite', 'build'])
    assert.equal(command.varsPresent, false)
    assert.equal(command.authEnv, undefined)
    assert.equal(command.loadDevVars, 'false')
    assert.equal(command.includeProcessEnv, 'false')
    assert.doesNotMatch(result.stdout + result.stderr, /unit-private-|inherited-build-secret/)
  }
})

test('the dev fixture rejects missing or empty required credentials before spawning', async (t) => {
  for (const key of ['OWNER_EMAIL', 'SESSION_SECRET']) {
    for (const value of [undefined, '', '   ']) {
      const { dir, run } = await fixture(t)
      const vars = { OWNER_EMAIL: 'owner@example.test', SESSION_SECRET: 'private-session', AUTH_LOCAL: 'true', AUTH_ORIGIN: 'http://127.0.0.1:8899', [key]: value }
      await writeFile(join(dir, '.dev.vars'), Object.entries(vars).filter(([,v]) => v !== undefined).map(([k,v]) => `${k}=${v}\n`).join(''))
      const result = await run([], {}, 'local-dev')
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes(`${key} is missing or empty`))
      await assert.rejects(stat(join(dir, 'calls.jsonl')), { code: 'ENOENT' })
    }
  }
})

test('the dev fixture turns a busy port into one plain message instead of a stack dump', async (t) => {
  const { dir, run } = await fixture(t)
  await writeFile(join(dir, '.dev.vars'), 'OWNER_EMAIL=owner@example.test\nSESSION_SECRET=private-session\nAUTH_LOCAL=true\nAUTH_ORIGIN=http://127.0.0.1:8899\n')
  const result = await run([], { TEST_PORT_BUSY: '8899' }, 'local-dev')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Port 8899 is in use\. Stop the other local server, then run node scripts\/local-dev\.mjs again\./)
  assert.doesNotMatch(result.stderr, /EADDRINUSE|Address already in use|kj\/|node:events|at Server/)
})


test('overlapping setup and builds cannot restore credentials into an active build', async (t) => {
  const { dir, run } = await fixture(t)
  const operation = await localOperation(dir)
  const lock = join(dir, '.wrangler/local-operation/active.json')
  const owner = await readFile(lock)
  try {
    for (const script of ['local-setup', 'local-build']) {
      const result = await run([], {}, script)
      assert.equal(result.code, 1)
      assert.match(result.stderr, new RegExp(`\\bPID ${process.pid} \\([a-zA-Z0-9._-]+\\)`))
      assert.ok(owner.equals(await readFile(lock)), 'refused commands preserve the live lock')
    }
    await assert.rejects(stat(join(dir, 'calls.jsonl')), { code: 'ENOENT' })
    const nested = await localOperation(dir, operation.token)
    await nested.release()
    assert.ok(owner.equals(await readFile(lock)), 'nested release preserves its parent lock')
    await assert.rejects(localOperation(dir), { code: 'LOCAL_OPERATION_BUSY', ownerPid: process.pid })
    assert.ok(owner.equals(await readFile(lock)), 'a competing acquisition preserves the live lock')
  } finally { await operation.release() }
  const next = await localOperation(dir)
  await next.release()
})

test('a lock left by a killed setup or build is taken over, a live one is not', async (t) => {
  const { dir } = await fixture(t)
  const lock = join(dir, '.wrangler/local-operation/active.json')
  const first = await localOperation(dir)
  // Simulate a hard kill: the file stays, its recorded process is gone.
  const { pid } = JSON.parse(await readFile(lock, 'utf8'))
  assert.equal(pid, process.pid)
  await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead' }))
  const second = await localOperation(dir)
  assert.notEqual(second.token, 'dead')
  const replacement = await readFile(lock)
  await assert.rejects(localOperation(dir), { code: 'LOCAL_OPERATION_BUSY', ownerPid: process.pid })
  assert.ok(replacement.equals(await readFile(lock)), 'a live replacement lock cannot be taken over')
  await first.release().catch(() => {})
  assert.ok(replacement.equals(await readFile(lock)), 'the stale owner cannot release the replacement lock')
  await second.release()
  await assert.rejects(stat(lock), { code: 'ENOENT' })
})
