import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The people page through the built Worker: a create form posted twice (a
// refresh, Back, a double click) creates one person, and its activity reads as
// names, business-zone times and labelled fields, never UUIDs or raw JSON.

async function rows(persistPath, query) {
  const directory = join(persistPath, 'v3/d1/miniflare-D1DatabaseObject')
  const file = (await readdir(directory)).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
  const db = new DatabaseSync(join(directory, file), { readOnly: true })
  try { return db.prepare(query).all() } finally { db.close() }
}

export async function refreshSafeCreate({ baseUrl, cookie, persistPath }) {
  const form = await fetch(`${baseUrl}/app/people`, { headers: { cookie } }).then((response) => response.text())
  const key = form.match(/name="commandKey" value="([^"]+)"/)?.[1]
  assert.ok(key, 'the create form carries a command key')
  const post = () => fetch(`${baseUrl}/app/people`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, origin: baseUrl, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ commandKey: key, name: 'Refresh Person', email: 'refresh.person@example.test' }),
  })
  const first = await post(), second = await post()
  for (const response of [first, second]) {
    assert.equal(response.status, 303, 'a successful create answers 303 to a GET')
    assert.equal(response.headers.get('location'), `/app/people?done=${key}`)
  }
  const [{ count }] = await rows(persistPath, "SELECT count(*) AS count FROM people WHERE email='refresh.person@example.test'")
  assert.equal(count, 1, 'the same POST twice creates one person')
  const result = await fetch(baseUrl + first.headers.get('location'), { headers: { cookie } })
  assert.equal(result.status, 200)
  assert.match(await result.text(), /Added Refresh Person\./)
  return { posts: 2, created: count }
}

export async function readableActivity({ baseUrl, cookie, persistPath, execute }) {
  const [owner] = await rows(persistPath, "SELECT id,display_name FROM oa_operators WHERE role='owner'")
  const departed = '0b9d3a52-6c1e-4a7f-9d55-3f1f0f3c2e11'
  const details = JSON.stringify({ approvedBy: owner.id, decision: { outcome: 'approved', reviewedAt: '2026-10-16T03:04:00Z' }, lines: [1, 2] }).replaceAll("'", "''")
  await execute(`INSERT INTO audit_events(id,actor,action,entity_type,entity_id,details,created_at) VALUES('01JREADABLEACTIVITY0000001','${departed}','record.approved','record','r1','${details}','2026-10-16T03:05:00.000Z')`)
  const html = await fetch(`${baseUrl}/app/people`, { headers: { cookie } }).then((response) => response.text())
  assert.match(html, new RegExp(`${owner.display_name} · \\d{1,2} [A-Z][a-z]{2} \\d{4}, \\d{1,2}:\\d{2} [ap]m AE[DS]T`), 'actors read as name · time in the business time zone')
  assert.match(html, /Former member · 16 Oct 2026, 2:05 pm AEDT/, 'an actor the installation no longer knows reads as a former member')
  assert.match(html, /<dt>Approved by<\/dt><dd>Reference Owner<\/dd>/)
  assert.match(html, /<dt>Decision › Reviewed at<\/dt><dd>16 Oct 2026, 2:04 pm AEDT<\/dd>/)
  assert.match(html, /<dt>Lines<\/dt><dd>1, 2<\/dd>/)
  for (const raw of [departed, owner.id, '[object Object]', '{&#34;', '{"']) assert.equal(html.includes(raw), false, `the page never shows ${raw}`)
  return { actors: 'named', evidence: 'labelled' }
}
