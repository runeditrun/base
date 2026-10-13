import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { hash } from './receipt.mjs';
// Separate private transport, never included in the bounded report bundle.
export async function preserveImages(ctx) {
  const output = ctx.output + '-images'; mkdirSync(output, { recursive: true });
  const images = Object.values(ctx.images); assert.equal(images.length, 3);
  const child = spawn('docker', ['save', ...images], { env: ctx.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let total = 0, part = [], partSize = 0, stderr = '', timedOut = false; const chunks = [], full = createHash('sha256');
  const startedUtc = new Date().toISOString(); const limit = 48 * 1024 * 1024;
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 300000);
  child.stderr.on('data', b => { stderr += b; if (stderr.length > 1024 * 1024) stop(); });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const flush = () => { const bytes = Buffer.concat(part), name = 'images.tar.part-' + String(chunks.length).padStart(3, '0'); writeFileSync(join(output, name), bytes, { mode: 0o600 }); chunks.push({ path: name, size: bytes.length, sha256: hash(bytes) }); part = []; partSize = 0; };
  try {
    for await (const data of child.stdout) {
      total += data.length; assert(total <= 4 * 1024 ** 3, 'image-transport-4GiB-limit'); full.update(data);
      let offset = 0; while (offset < data.length) { const n = Math.min(limit - partSize, data.length - offset); part.push(data.subarray(offset, offset + n)); partSize += n; offset += n; if (partSize === limit) flush(); }
    }
    if (partSize) flush(); const exitCode = await completion;
    ctx.receipt.command({ argv: ['docker', 'save', ...images], cwd: ctx.checkout, startedUtc, finishedUtc: new Date().toISOString(), exitCode, timedOut, stdout: Buffer.from(JSON.stringify({ total, chunks: chunks.length })), stderr });
    assert.equal(exitCode, 0); assert.equal(timedOut, false); assert(total > 0);
    const value = { version: 1, images: ctx.images, size: total, sha256: full.digest('hex'), chunks,
      status: 'prepared-for-private-upload', retentionDays: 7, transport: 'private Actions artifact; root must independently verify upload digest and image IDs after docker load' };
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(value, null, 2) + '\n');
    ctx.receipt.file('runtime/image-custody.json', value, ['docker-inspect']); ctx.receipt.value.imageCustody = value;
  } finally { clearTimeout(timer); stop(); await completion; }
}
