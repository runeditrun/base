const element = id => document.getElementById(id)
let plan
let sourceLabels = new Map()
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
async function request(path, body) {
  const response = await fetch('/api/operator/' + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) { const error = new Error(data.error || 'The request failed.'); error.data = data; throw error }
  return data
}
const failureMessage = code => ({ import_door_apply_constraint: 'A record did not meet the destination’s rules.', import_door_apply_transient: 'The destination was temporarily unavailable.', import_door_apply_failed: 'The destination could not apply a record.' })[code] || String(code || 'The destination changed or rejected a record.').replaceAll('_', ' ')
const door = (action, body) => request('import/' + action, body)
const notice = text => { element('notice').textContent = text }
function items(id, values) {
  const list = element(id)
  list.replaceChildren(...values.map(value => { const li = document.createElement('li'); li.textContent = value; return li }))
}
function summarize(value) {
  return typeof value === 'object' && value !== null ? Object.entries(value).map(([key, item]) => `${key}: ${summarize(item)}`).join(', ') : String(value)
}
function showPlan(next) {
  plan = next
  sessionStorage.setItem('people-import-plan', next.planId)
  element('review').hidden = false
  element('result').hidden = true
  element('confirmed').checked = false
  element('fingerprint').textContent = next.fingerprint
  const counts = element('counts')
  counts.replaceChildren(...Object.entries({ ...next.summary, ...next.counts }).flatMap(([key, value]) => {
    const term = document.createElement('dt'), detail = document.createElement('dd')
    term.textContent = key.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase()); detail.textContent = summarize(value)
    return [term, detail]
  }))
  items('differences', Object.entries(next.differences).map(([key, values]) => `${key}: ${values.length}${values.length ? ' · ' + values.map(value => { const [, id] = JSON.parse(value); return sourceLabels.get(id) || id }).join(', ') : ''}`))
  items('rejections', next.rejected?.length ? next.rejected.map(summarize) : ['No rejected records.'])
  notice('Review the counts, differences and rejections before approving. Nothing has been imported yet.')
}
async function history() {
  const data = await request('import-history')
  const rows = data.history
  const host = element('history')
  host.replaceChildren()
  if (!rows.length) { host.textContent = 'No approved imports yet.'; return }
  for (const entry of rows) {
    const section = document.createElement('section'), title = document.createElement('h3'), caption = document.createElement('p'), open = document.createElement('button')
    title.textContent = entry.state.replaceAll('_', ' ')
    caption.textContent = `${entry.failureCode ? 'approved, then failed' : 'approved'}${entry.reviewer === entry.approvalRecordId ? ' via Business' : ''} by ${entry.owner} · ${new Date(entry.approvedAt).toLocaleString()}`
    open.textContent = 'Open import'
    open.onclick = () => run(async () => { plan = { planId: entry.planId, fingerprint: entry.fingerprint }; sessionStorage.setItem('people-import-plan', entry.planId); await status() })
    section.append(title, caption, open); host.append(section)
  }
}
function showJob(data) {
  const job = data.job
  const reversed = ['undone', 'rolled_back'].includes(job.state)
  element('review').hidden = true
  element('result').hidden = false
  element('result-title').textContent = job.state === 'completed' ? 'Import completed' : reversed ? 'Import undone' : job.state === 'failed' ? 'Import failed' : 'Import in progress'
  element('result-description').textContent = job.state === 'failed'
    ? `This approval cannot be applied again. ${failureMessage(data.failureCode || job.error)} Undo any applied records, then upload and review a new plan.`
    : job.state === 'completed' ? 'The imported people are ready to inspect. Reconcile checks them against native data; Undo removes unchanged imported records.'
    : reversed ? 'Undo finished. Native edits are protected by the import engine.' : 'Continue from the saved job. Each request applies a bounded batch.'
  element('resume').hidden = !['queued', 'applying'].includes(job.state)
  element('reconcile').hidden = job.state !== 'completed'
  element('undo').hidden = reversed
}
async function status() { showJob(await door('status', { planId: plan.planId })); await history() }
async function apply() {
  for (let batch = 0; batch < 100; batch++) {
    const data = await door('apply', { planId: plan.planId, reviewedFingerprint: plan.fingerprint })
    showJob(data)
    if (!['queued', 'applying'].includes(data.job.state)) { notice(data.job.state === 'completed' ? 'Import completed. Reconcile the native records or choose Undo.' : 'The import stopped. Check its saved status.'); await history(); return }
    notice(`Applying batch ${batch + 1}…`)
  }
  notice('Progress saved. Continue import to apply the next batches.')
}
async function run(action) {
  const buttons = [...document.querySelectorAll('button')]
  for (const button of buttons) button.disabled = true
  try { await action() }
  catch (error) {
    notice(`Could not finish: ${failureMessage(error.message)}`)
    if (plan) { try { await status() } catch { /* Keep the original failure visible. */ } }
  } finally { for (const button of buttons) button.disabled = false }
}
element('upload').onsubmit = event => {
  event.preventDefault()
  void run(async () => {
    const file = element('bundle').files[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const source = JSON.parse(new TextDecoder().decode(bytes))
    const records = Array.isArray(source) ? source : source.people
    sourceLabels = new Map((Array.isArray(records) ? records : []).filter(row => row && typeof row.ref === 'string').map(row => [row.ref, [row.name, row.email].filter(Boolean).join(' · ')]))
    const bundleSha256 = await hash(bytes), totalChunks = Math.ceil(bytes.length / 65536)
    if (!totalChunks) throw new Error('Choose a nonempty export')
    let uploadId
    for (let index = 0; index < totalChunks; index++) {
      const chunk = bytes.slice(index * 65536, (index + 1) * 65536)
      let binary = ''; for (const byte of chunk) binary += String.fromCharCode(byte)
      const result = await door('uploads', { uploadId, name: file.name, bundleSha256, totalBytes: bytes.length, totalChunks, index, chunkSha256: await hash(chunk), base64: btoa(binary) })
      uploadId = result.uploadId
      notice(`Uploaded chunk ${index + 1} of ${totalChunks}.`)
    }
    showPlan(await door('plan', { uploadId, ...(element('catchup').checked ? { catchup: true } : {}) }))
  })
}
element('approve').onsubmit = event => { event.preventDefault(); void run(apply) }
element('resume').onclick = () => { void run(apply) }
element('reconcile').onclick = () => { void run(async () => {
  const data = await door('reconcile', { planId: plan.planId })
  notice(data.ok ? `Reconciled: ${data.counts.present} present, ${data.counts.explained} explained, ${data.counts.sourceRecords} source records.` : 'Reconciliation found differences. Inspect native records before continuing.')
}) }
element('undo').onclick = () => { void run(async () => {
  for (let batch = 0; batch < 100; batch++) {
    const data = await door('undo', { planId: plan.planId }); showJob(data)
    if (['undone', 'rolled_back'].includes(data.job.state)) { notice('Import undone.'); await history(); return }
  }
  notice('Undo progress saved. Choose Undo import to continue.')
}) }
element('settings').onsubmit = event => { event.preventDefault(); void run(async () => {
  const kid = element('revoked-key').value.trim()
  await request('import-settings', { enabled: element('enabled').checked, ...(kid ? { revokedKids: [kid] } : {}) })
  element('revoked-key').value = ''; await settings(); notice('Import settings saved.')
}) }
async function settings() {
  const data = await request('import-settings')
  element('enabled').checked = data.enabled
  element('revocations').textContent = data.revokedKids.length ? 'Permanently revoked keys: ' + data.revokedKids.join(', ') : 'No revoked keys.'
}
void run(async () => {
  await settings(); await history()
  const saved = sessionStorage.getItem('people-import-plan')
  if (saved) {
    plan = { planId: saved }
    const data = await door('status', { planId: saved })
    plan.fingerprint = data.fingerprint
    if (data.job) showJob(data)
    else notice('Upload the export again to review a fresh plan before applying.')
  }
})
