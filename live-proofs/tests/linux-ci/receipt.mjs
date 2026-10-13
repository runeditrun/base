import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { PROOFS, EVIDENCE, SOURCE_GATE, BASE_IMAGE } from './constants.mjs';
import { Incomplete } from './commands.mjs';
export const hash = data => createHash('sha256').update(data).digest('hex');
export function manifest(root, prefix = '') {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const path = prefix ? prefix + '/' + name : name, stat = lstatSync(join(root, path));
    assert(!stat.isSymbolicLink(), 'manifest-link');
    return stat.isDirectory() ? manifest(root, path) : (assert(stat.isFile(), 'manifest-nonregular'), [{ path, size: stat.size, sha256: hash(readFileSync(join(root, path))) }]);
  });
}
export class Receipt {
  constructor(output, metadata) {
    mkdirSync(output, { recursive: true }); this.output = output; this.secrets = []; this.sequence = 0;
    this.sizes = new Map(manifest(output).map(f => [f.path, f.size]));
    this.value = { version: 1, task: 'T-016', scope: 'credential-free-linux', status: 'incomplete', sourceGate: { ...SOURCE_GATE },
      baseImage: BASE_IMAGE, images: {}, startedUtc: new Date().toISOString(), providerExecuted: false,
      hostedAcceptance: 'pending', publicationExecuted: false, commands: [], evidence: Object.fromEntries(EVIDENCE.map(k => [k, []])), ...metadata };
  }
  sanitize(data) { let s = String(data); for (const secret of this.secrets) s = s.split(secret).join('[synthetic-marker-redacted]'); return s; }
  file(name, data, groups = []) {
    assert(/^[a-zA-Z0-9_./-]+$/.test(name) && !name.split('/').includes('..'));
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(this.sanitize(typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'));
    assert(bytes.length < 50_000_000, 'report-file-limit');
    const total = [...this.sizes.values()].reduce((n, size) => n + size, 0) - (this.sizes.get(name) ?? 0) + bytes.length;
    assert(total < (name.startsWith('receipt.') ? 100_000_000 : 95_000_000), 'report-tree-limit');
    for (const secret of this.secrets) assert(!bytes.includes(Buffer.from(secret)), 'retained-synthetic-marker');
    mkdirSync(join(this.output, name, '..'), { recursive: true }); writeFileSync(join(this.output, name), bytes, { mode: 0o600 }); this.sizes.set(name, bytes.length);
    for (const group of groups) { assert(EVIDENCE.includes(group)); if (!this.value.evidence[group].includes(name)) this.value.evidence[group].push(name); }
    return name;
  }
  command(result, groups = []) {
    const name = 'raw/command-' + String(++this.sequence).padStart(5, '0');
    const retain = (stream, data) => {
      const bytes = Buffer.from(this.sanitize(data));
      const compressed = bytes.length > 16 * 1024;
      return { path: this.file(name + '.' + stream + '.log' + (compressed ? '.gz' : ''), compressed ? gzipSync(bytes, { level: 9 }) : bytes, groups),
        encoding: compressed ? 'gzip' : 'utf8', size: bytes.length, sha256: hash(bytes) };
    };
    const stdout = retain('stdout', result.stdout ?? result.output ?? '');
    const stderr = retain('stderr', result.stderr ?? '');
    const row = { argv: result.argv, cwd: result.cwd, startedUtc: result.startedUtc, finishedUtc: result.finishedUtc,
      exitCode: result.exitCode, timedOut: result.timedOut ?? (result.exitCode === -1 ? null : false), termination: result.exitCode === -1 && result.timedOut === undefined ? 'native-runner-does-not-distinguish-timeout-signal-or-output-limit' : undefined, overflow: result.overflow ?? false,
      stdout: stdout.path, stderr: stderr.path, streams: { stdout, stderr } };
    this.file(name + '.json', row, groups); return row;
  }
  async proof(id, action, argv = process.argv) {
    const row = { id, argv, cwd: process.cwd(), startedUtc: new Date().toISOString(), exitCode: -1, timedOut: false, status: 'incomplete' };
    try { await action(); row.exitCode = 0; row.status = 'pass'; }
    catch (e) { row.status = e instanceof Incomplete ? 'incomplete' : 'fail'; row.error = this.sanitize(e.message); }
    row.finishedUtc = new Date().toISOString(); row.log = this.file('proofs/' + id + '.json', row);
    this.value.commands.push(row); return row.status === 'pass';
  }
  finish() {
    for (const id of PROOFS) if (!this.value.commands.some(r => r.id === id)) this.value.commands.push({ id, argv: [], cwd: process.cwd(),
      startedUtc: null, finishedUtc: null, exitCode: null, timedOut: false, status: 'incomplete', reason: 'prerequisite-not-complete', log: 'receipt.json' });
    const passed = this.value.commands.every(r => r.status === 'pass') && EVIDENCE.every(k => this.value.evidence[k].length > 0) && this.value.imageCustody?.status === 'prepared-for-private-upload';
    this.value.status = this.value.commands.some(r => r.status === 'fail') ? 'fail' : passed ? 'pass' : 'incomplete';
    this.value.finishedUtc = new Date().toISOString();
    const files = manifest(this.output).filter(f => f.path !== 'receipt.json' && f.path !== 'receipt.sha256');
    assert(files.reduce((n, f) => n + f.size, 0) < 99 * 1024 * 1024, 'report-tree-limit');
    this.value.files = Object.fromEntries(files.map(f => [f.path, { size: f.size, sha256: f.sha256 }]));
    this.file('receipt.json', this.value); this.file('receipt.sha256', hash(readFileSync(join(this.output, 'receipt.json'))) + '  receipt.json\n');
    return this.value;
  }
}
