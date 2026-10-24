import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, unlink } from 'node:fs/promises';
import { processInfo, inspectionBound } from './processes.mjs';

// A lifetime nonce supplements Darwin's second-resolution ps start time.
// It also distinguishes two library clients in the same Node process.
export async function identity() {
  // A process-table outage does not prevent this client from proving its own
  // lifetime by nonce. It grants no process birth or command ownership claim.
  const current = await processInfo(process.pid).catch(() => undefined);
  const { title: command, ...processIdentity } = current ?? { pid: process.pid, unchecked: true };
  const token = randomUUID(), socket = join(tmpdir(), `rer-job-${token}.sock`);
  // Darwin's TMPDIR can be long; use the short system temporary directory then.
  const path = Buffer.byteLength(socket) < 100 ? socket : `/tmp/rer-job-${token}.sock`;
  // A prober that timed out or exited may close before the answer is written;
  // the prober reports that itself, so the answer's EPIPE or ECONNRESET is dropped.
  const clients = new Set();
  const server = createServer(client => {
    clients.add(client); client.once('close', () => clients.delete(client));
    client.on('error', () => {}); client.end(token);
  });
  let closing, listening = false;
  const close = () => closing ??= (async () => {
    for (const client of clients) client.destroy();
    if (!listening) return;
    await new Promise(resolve => server.close(resolve));
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  })();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, () => { listening = true; resolve(); }); });
    await chmod(path, 0o600);
    return { info: { ...processIdentity, token, socket: path }, command, close };
  } catch (error) { await close(); throw error; }
}

// A liveness hint for retaining leases, never permission to signal a PID.
// Inspect process birth and nonce concurrently so the whole sample has one
// three-second bound. Unknown owners stay held; only definite contrary evidence
// reclaims them. A nonce still verifies a client created without process data.
export const alive = async (owner, inspection) => (await inspectOwner(owner, inspection)).alive;

// Registry callers also need the same birth/command sample for custody checks.
export async function inspectOwner(owner, inspection = {}) {
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) return { current: undefined, alive: false };
  const [current, responsive] = await Promise.all([
    processInfo(owner.pid, inspection).catch(() => undefined),
    owner.socket && owner.token ? probe(owner, inspection.bound).catch(() => undefined) : undefined
  ]);
  if (current === null || current?.zombie || current && owner.start != null && current.start !== owner.start) return { current, alive: false };
  if (!owner.socket || !owner.token) throw Error('Lease lacks lifetime identity');
  return { current, alive: responsive ?? true };
}

function probe(owner, bound = inspectionBound) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(owner.socket);
    let body = '';
    const finish = (value, error) => {
      clearTimeout(timer); connection.destroy();
      if (error) reject(error); else resolve(value);
    };
    // An absolute deadline also ends peers that keep sending partial replies.
    const timer = setTimeout(() => finish(undefined), Math.min(bound, inspectionBound));
    connection.on('data', data => { body += data; if (body.length > 128) finish(undefined); });
    connection.on('end', () => finish(body === owner.token));
    connection.on('close', () => finish(undefined));
    connection.on('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) finish(false);
      else finish(undefined, error);
    });
  });
}
