import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { emittedRuntime, owner, root, setupToken } from './emitted-runtime.mjs'
import { signSettings, testDocument, testTrust } from '../../../modules/business-settings/testing/index.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const cookieOf = response => { assert.equal(response.status, 303); return response.headers.get('set-cookie').split(';')[0] }
const tokenOf = mail => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token')
const business = { settings: 1, values: ['display_name', 'owner_name', 'brand_color', 'logo', 'timezone'], team: { roles: { admin: 'admin', member: 'member' } } }

// One public-door core flow, shared with the emitted-Worker verification shard.
// Only outbound mail is replaced, by emittedRuntime's network-edge sink.
test('Business settings on the emitted Worker: signed door, runtime branding, overrides, native team and owner exit', async () => {
  const evidence = { door: [], html: {}, headers: {}, team: [], homepage: [] }
  const output = process.env.BUSINESS_SETTINGS_EVIDENCE_DIR
  const scratch = await mkdtemp(join(tmpdir(), 'business-settings-api-'))
  let runtime, browser
  async function boot(bindings = {}) {
    runtime = await emittedRuntime({ bindings })
    const response = await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Alex Rivera' } })
    return cookieOf(response)
  }
  async function post(document, expected, name, logo) {
    const response = await runtime.call('/api/rer/business-settings', { method: 'POST', input: { settings: await signSettings(document), ...(logo === undefined ? {} : { logo }) } })
    const result = await response.json()
    assert.equal(response.status, expected, `${name}: ${JSON.stringify(result)}`)
    evidence.door.push({ request: name, status: response.status, response: result })
    return result
  }
  const finish = cookie => runtime.call('/setup', { method: 'POST', cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' })
  async function capture(path, name, cookie) {
    if (!output) return
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    if (cookie) { const at = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, at), value: cookie.slice(at + 1), url: runtime.origin }]) }
    const page = await context.newPage(), images = []
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
      await page.goto(runtime.origin + path)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(200)
      images.push(await page.screenshot({ path: join(output, `${name}-${width}.png`), fullPage: true, animations: 'disabled' }))
    }
    await context.close()
    return images
  }
  try {
    if (output) { await mkdir(output, { recursive: true }); const { chromium } = await import('@playwright/test'); browser = await chromium.launch({ headless: true }) }
    await boot()
    const off = await runtime.call('/api/rer/business-settings', { method: 'POST', input: {} })
    assert.equal(off.status, 404); evidence.door.push({ request: 'no trust', status: off.status })
    await runtime.close(); runtime = null

    const trust = testTrust(), ownerCookie = await boot({ RER_BUSINESS_TRUST: JSON.stringify(trust) })
    assert.equal(await runtime.call('/rer-business.css').then(response => response.text()), '')
    const beforeHomepage = await capture('/', 'homepage-before')
    const logoBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><defs><path id="leaf" d="M55 22C24 20 20 40 27 55c22 5 34-10 28-33Z"/></defs><rect width="80" height="80" rx="16" fill="#245943"/><use href="#leaf" fill="#fff"/></svg>')
    const logo = { sha256: digest(logoBytes), type: 'image/svg+xml', bytes: logoBytes.length }
    const member = { email: 'sam@example.test', name: 'Sam Chen', role: 'member', invite: 0 }
    let document = testDocument({ logo, team: [member] })
    const ack = await post(document, 200, 'valid document', logoBytes.toString('base64'))
    assert.equal(ack.rev, 1); assert.equal(ack.logo, logo.sha256); assert.deepEqual(ack.team, [{ email: member.email, state: 'invited' }])
    assert.equal(runtime.mails.length, 1)
    const invitation = runtime.mails[0]
    assert.match(invitation.from, /Cedar Works/)
    const invited = await runtime.db.prepare('SELECT email,role,status FROM oa_operators WHERE email=?').bind(member.email).first()
    assert.equal(invited.status, 'invited'); evidence.team.push({ action: 'add', operator: invited, mails: runtime.mails.length })

    const signin = await runtime.call('/signin'), signinHtml = await signin.text()
    assert.match(signinHtml, /Cedar Works/); assert.match(signinHtml, new RegExp(`/rer-business-logo\\?v=${logo.sha256.slice(0, 12)}`))
    evidence.html.signin = signinHtml.match(/<p class="brand">.*?<\/p>/)?.[0]
    await capture('/signin', 'signin')
    const setupHtml = await runtime.call('/setup', { cookie: ownerCookie }).then(r => r.text())
    assert.match(setupHtml, /Cedar Works/); assert.match(setupHtml, /rer-business-logo/)
    evidence.html.setup = setupHtml.match(/<p class="rer-brand">.*?<\/p>/)?.[0]
    await capture('/setup', 'setup', ownerCookie)
    assert.equal((await finish(ownerCookie)).status, 303)
    const appHtml = await runtime.call('/app', { cookie: ownerCookie }).then(r => r.text())
    assert.match(appHtml, /Cedar Works/); assert.match(appHtml, /href="\/rer-business.css"/)
    evidence.html.app = appHtml.match(/<section aria-label="Workspace".*?<\/section>/)?.[0]
    await capture('/app', 'app', ownerCookie)
    await capture('/auth/settings/identity', 'business-settings', ownerCookie)
    const logoResponse = await runtime.call(`/rer-business-logo?v=${logo.sha256.slice(0, 12)}`)
    assert.equal(logoResponse.status, 200); assert.equal(digest(Buffer.from(await logoResponse.arrayBuffer())), logo.sha256)
    evidence.headers.logo = Object.fromEntries(logoResponse.headers)
    assert.match(logoResponse.headers.get('cache-control'), /immutable/)
    assert.equal(logoResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(logoResponse.headers.get('cross-origin-resource-policy'), 'cross-origin')
    assert.match(logoResponse.headers.get('content-security-policy'), /sandbox/)
    const unversioned = await runtime.call('/rer-business-logo')
    assert.equal(unversioned.headers.get('etag'), `"${logo.sha256}"`); assert.match(unversioned.headers.get('cache-control'), /max-age=300/)
    evidence.headers.unversionedLogo = Object.fromEntries(unversioned.headers)
    const cssResponse = await runtime.call('/rer-business.css'), css = await cssResponse.text()
    assert.match(css, /--rer-business-accent:#245943;--rer-business-accent-text:#ffffff/)
    evidence.html.css = css; evidence.headers.css = Object.fromEntries(cssResponse.headers)
    const homepage = await runtime.call('/').then(r => r.text())
    assert.doesNotMatch(homepage, /rer-business.css/)
    const afterHomepage = await capture('/', 'homepage-after')
    if (output) for (const [i, width] of [1440, 390].entries()) {
      assert.deepEqual(afterHomepage[i], beforeHomepage[i], `homepage unchanged at ${width}`)
      evidence.homepage.push({ width, before: digest(beforeHomepage[i]), after: digest(afterHomepage[i]), identical: true })
    }

    for (const [field, value] of [['iss', 'https://other.example.test'], ['aud', 'https://other.example.test'], ['sub', 'other/installation'], ['email', 'other@example.test']]) await post({ ...document, rev: 2, [field]: value }, 403, `wrong ${field}`)
    for (const [field, value] of [['kid', 'unknown'], ['typ', 'rer-import-grant+jwt']]) {
      const response = await runtime.call('/api/rer/business-settings', { method: 'POST', input: { settings: await signSettings({ ...document, rev: 2 }, { [field]: value }) } })
      assert.equal(response.status, 403); evidence.door.push({ request: `wrong ${field}`, status: response.status, response: await response.json() })
    }
    const token = await signSettings({ ...document, rev: 2 }), parts = token.split('.')
    const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1; parts[2] = signature.toString('base64url')
    const wrongSignature = await runtime.call('/api/rer/business-settings', { method: 'POST', input: { settings: parts.join('.') } })
    assert.equal(wrongSignature.status, 403); evidence.door.push({ request: 'wrong signature', status: wrongSignature.status, response: await wrongSignature.json() })
    const now = Math.floor(Date.now() / 1000)
    await post({ ...document, rev: 2, iat: now - 100, exp: now - 1 }, 403, 'expired document')
    await post({ ...document, rev: 2, unknown: 'refused' }, 403, 'unknown payload key')
    const fullRow = () => runtime.db.prepare('SELECT * FROM bs_settings').first()
    const rowBefore = await fullRow()
    await post(document, 409, 'equal rev')
    await post({ ...document, rev: 0 }, 409, 'older revision zero')
    assert.deepEqual(await fullRow(), rowBefore)
    // Give the lower-revision case two valid positive revisions.
    document = { ...document, rev: 2 }
    await post(document, 200, 'next revision')
    const olderBefore = await fullRow()
    await post({ ...document, rev: 1 }, 409, 'older rev')
    assert.deepEqual(await fullRow(), olderBefore)
    const rowSummary = row => ({ rev: row.rev, applied_at: row.applied_at, stopped: row.stopped, document_bytes: Buffer.byteLength(row.document), document_sha256: digest(row.document) })
    evidence.replay = { equal: { before: rowSummary(rowBefore), after: rowSummary(rowBefore) }, older: { before: rowSummary(olderBefore), after: rowSummary(await fullRow()) } }
    await post({ ...document, rev: 3, logo: { ...logo, sha256: '0'.repeat(64) } }, 400, 'wrong logo hash', logoBytes.toString('base64'))
    await post({ ...document, rev: 3, logo: { ...logo, sha256: '1'.repeat(64) } }, 400, 'logo required but missing')
    const oversized = await runtime.call('/api/rer/business-settings', { method: 'POST', body: JSON.stringify({ settings: 'x'.repeat(512 * 1024) }) })
    assert.equal(oversized.status, 413); evidence.door.push({ request: 'more than 512 KB', status: oversized.status, response: await oversized.json() })

    await build({ entryPoints: [join(root, '../modules/business-settings/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(scratch, 'api.mjs') })
    const { createBusinessSettings } = await import(pathToFileURL(join(scratch, 'api.mjs')))
    const settings = createBusinessSettings({ db: runtime.db, business, trust })
    await settings.setOverride('display_name', 'Cedar Studio', owner)
    document = { ...document, rev: 3, values: { ...document.values, display_name: 'Cedar Group' } }
    const overridden = await post(document, 200, 'document with local override')
    assert.deepEqual(overridden.overrides, ['display_name']); assert.equal(await settings.resolve('display_name', 'seed'), 'Cedar Studio')
    await settings.clearOverride('display_name', owner)
    assert.equal(await settings.resolve('display_name', 'seed'), 'Cedar Group')
    evidence.override = { persisted: 'Cedar Studio', ack: overridden.overrides, cleared: await settings.resolve('display_name', 'seed') }

    const memberCookie = cookieOf(await runtime.call('/auth/confirm', { method: 'POST', input: { token: tokenOf(invitation) } }))
    assert.equal((await runtime.call('/api/work', { cookie: memberCookie })).status, 200)
    evidence.team.push({ action: 'accept invitation', session: 200 })
    document = { ...document, rev: 4, team: [{ ...member, role: 'admin' }] }
    await post(document, 200, 'team role change')
    const operators = await runtime.call('/auth/operators', { cookie: ownerCookie }).then(r => r.json())
    assert.equal(operators.find(o => o.email === member.email).role, 'admin')
    evidence.team.push({ action: 'role change', operator: operators.find(o => o.email === member.email) })
    await runtime.call('/auth/magic-link', { method: 'POST', input: { email: member.email } })
    const openSession = cookieOf(await runtime.call('/auth/confirm', { method: 'POST', input: { token: tokenOf(runtime.mails.at(-1)) } }))
    document = { ...document, rev: 5, team: [] }; await post(document, 200, 'team removal')
    assert.equal((await runtime.call('/api/work', { cookie: openSession })).status, 401)
    assert.equal((await runtime.db.prepare('SELECT status FROM oa_operators WHERE email=?').bind(member.email).first()).status, 'inactive')
    evidence.team.push({ action: 'remove', status: 'inactive', openSession: 401 })
    document = { ...document, rev: 6, team: [{ ...member, role: 'admin' }] }; const readded = await post(document, 200, 'team re-add')
    assert.equal(readded.team.find(m => m.email === member.email).state, 'active'); evidence.team.push({ action: 're-add', status: 'active' })
    const existingEmail = 'existing@example.test'
    assert.equal((await runtime.call('/auth/invite', { method: 'POST', cookie: ownerCookie, input: { email: existingEmail, displayName: 'Existing operator', role: 'member' } })).status, 202)
    const existingBefore = await runtime.db.prepare('SELECT * FROM oa_operators WHERE email=?').bind(existingEmail).first()
    const ownerBefore = await runtime.db.prepare('SELECT * FROM oa_operators WHERE email=?').bind(owner).first()
    document = { ...document, rev: 7, team: [...document.team, { ...member, email: existingEmail }, { ...member, email: owner }] }
    const conflict = await post(document, 200, 'pre-existing and owner conflict')
    assert.equal(conflict.team.find(m => m.email === existingEmail).state, 'conflict')
    assert.deepEqual(await runtime.db.prepare('SELECT * FROM oa_operators WHERE email=?').bind(existingEmail).first(), existingBefore)
    assert.deepEqual(await runtime.db.prepare('SELECT * FROM oa_operators WHERE email=?').bind(owner).first(), ownerBefore)
    evidence.team.push({ action: 'conflicts', team: conflict.team, existingUnchanged: true, ownerUnchanged: true })
    const pending = { ...member, email: 'pending@example.test', name: 'Morgan Lee' }
    document = { ...document, rev: 8, team: [document.team[0], pending] }; await post(document, 200, 'pending invitation')
    const priorMails = runtime.mails.length
    document = { ...document, rev: 9, team: [document.team[0], { ...pending, invite: 1 }] }; await post(document, 200, 'invite bump')
    assert.equal(runtime.mails.length, priorMails + 1)
    document = { ...document, rev: 10, team: [document.team[0]] }; await post(document, 200, 'cancel pending invitation')
    assert.ok(await runtime.db.prepare('SELECT 1 FROM oa_invitation_cancellations c JOIN oa_operators o ON o.id=c.operator_id WHERE o.email=?').bind(pending.email).first())
    const audit = await runtime.db.prepare("SELECT actor_id,action,value FROM oa_auth_audit WHERE json_extract(value,'$.via') LIKE 'via Business by %'").all()
    assert.ok(audit.results.length); assert.ok(audit.results.every(row => row.actor_id === ownerBefore.id))
    evidence.team.push({ action: 'resend and cancellation', additionalMail: 1, audit: audit.results })
    document = { ...document, rev: 11, detached: true, logo: null }
    await post(document, 200, 'detach')
    const detached = await runtime.call('/api/rer/business-settings', { method: 'POST', input: {} })
    assert.equal(detached.status, 404); evidence.door.push({ request: 'after detached', status: detached.status })
    assert.equal(await settings.resolve('display_name', 'seed'), 'Cedar Group')
    await runtime.close(); runtime = null

    const stopCookie = await boot({ RER_BUSINESS_TRUST: JSON.stringify(trust) })
    await post(testDocument(), 200, 'before stop')
    assert.equal((await runtime.call('/auth/settings/business', { method: 'POST', cookie: stopCookie, input: {} })).status, 403)
    assert.equal((await runtime.call('/auth/step-up', { method: 'POST', cookie: stopCookie, input: { action: 'business:stop', returnTo: '/auth/settings/identity' } })).status, 202)
    assert.equal((await runtime.call('/auth/confirm', { method: 'POST', cookie: stopCookie, input: { token: tokenOf(runtime.mails.at(-1)) } })).status, 303)
    assert.equal((await runtime.call('/auth/settings/business', { method: 'POST', cookie: stopCookie, input: {} })).status, 200)
    const stopped = await runtime.call('/api/rer/business-settings', { method: 'POST', input: {} })
    assert.equal(stopped.status, 404); evidence.door.push({ request: 'after owner stop', status: stopped.status })
    await capture('/auth/settings/identity', 'business-stopped', stopCookie)
    const sources = (await Promise.all((await readdir(join(root, 'dist/server/assets'))).filter(f => f.endsWith('.js')).map(f => readFile(join(root, 'dist/server/assets', f), 'utf8')))).join('\n') + await readFile(join(root, 'dist/server/index.js'), 'utf8')
    assert.doesNotMatch(sources, /business-test-only|signSettings|fixtureKeys|"d"\s*:/)
    if (output) await writeFile(join(output, 'core-flow.json'), JSON.stringify(evidence, null, 2) + '\n')
  } finally { await browser?.close(); await runtime?.close(); await rm(scratch, { recursive: true, force: true }) }
})
