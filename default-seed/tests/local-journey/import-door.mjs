import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function door(owner, action, body) {
  return owner('POST', `/api/operator/import/${action}`, body)
}
export async function planPeople(owner, name, people, catchup = false) {
  const bytes = Buffer.from(JSON.stringify(people))
  const totalChunks = Math.ceil(bytes.length / 65536)
  let uploadId
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.subarray(index * 65536, (index + 1) * 65536)
    const result = await door(owner, 'uploads', { uploadId, name, bundleSha256: hash(bytes), totalBytes: bytes.length,
      totalChunks, index, chunkSha256: hash(chunk), base64: chunk.toString('base64') })
    assert.equal(result.status, 200, `upload: ${JSON.stringify(result.json)}`)
    uploadId = result.json.uploadId
  }
  const uploaded = await door(owner, 'uploads', { uploadId })
  assert.equal(uploaded.status, 200)
  assert.equal(uploaded.json.complete, true)
  const result = await door(owner, 'plan', { uploadId, ...(catchup ? { catchup: true } : {}) })
  assert.equal(result.status, 200, `plan: ${JSON.stringify(result.json)}`)
  assert.equal(result.json.summary.sourceRecords, people.length)
  assert.equal(result.json.counts.rejected, 0)
  return result.json
}
export const applyDoor = (owner, plan) => door(owner, 'apply', { planId: plan.planId, reviewedFingerprint: plan.fingerprint })
export async function finishDoor(owner, action, plan, state = action === 'apply' ? 'completed' : 'undone') {
  for (let batch = 0; batch < 100; batch++) {
    const result = await (action === 'apply' ? applyDoor(owner, plan) : door(owner, action, { planId: plan.planId }))
    assert.equal(result.status, 200, `${action}: ${JSON.stringify(result.json)}`)
    if (result.json.job?.state === state) return result.json.job
    assert.ok(['queued', 'applying', 'undoing', 'rolling_back'].includes(result.json.job?.state), JSON.stringify(result.json))
  }
  assert.fail(`${action} did not reach ${state}`)
}
export async function assertWithdrawn(owner, plan) {
  const refused = await applyDoor(owner, plan)
  assert.deepEqual([refused.status, refused.json.error], [410, 'snapshot_withdrawn'])
  const status = await door(owner, 'status', { planId: plan.planId })
  assert.equal(status.status, 200)
  assert.equal(status.json.job.state, 'applying')
}
