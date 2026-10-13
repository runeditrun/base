import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { digest, insist } from '../../scripts/qualification/operations.mjs';

function paxFields(bytes) {
  insist(bytes.length <= 8192, 'oversize-tar-metadata');
  const fields = {}; let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, space).toString());
    insist(space > offset && Number.isSafeInteger(length) && length > space - offset + 2 &&
      offset + length <= bytes.length && bytes[offset + length - 1] === 10, 'invalid-tar-metadata');
    const entry = bytes.subarray(space + 1, offset + length - 1).toString(), separator = entry.indexOf('=');
    const key = entry.slice(0, separator), value = entry.slice(separator + 1);
    insist(separator > 0 && ['path','mtime','atime','ctime','uid','gid','uname','gname'].includes(key) &&
      !Object.hasOwn(fields,key), 'unsafe-tar-metadata');
    fields[key] = value; offset += length;
  }
  return fields;
}
// Never pass untrusted tar to a general archiver. PAX path names receive the
// same canonical validation as USTAR names; links/devices/size overrides fail.
export function unpackArtifact(tar, destination, prefix = '') {
  const files = [], seen = new Set(); let offset = 0, ended = false, pax = null;
  insist(tar.length <= 256 * 1024 * 1024, 'artifact-too-large');
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512); offset += 512;
    if (h.every(x => x === 0)) { insist(!pax,'orphan-tar-metadata'); ended = true; break; }
    const str = (start, length) => h.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const oct = (start, length) => { const s = str(start, length).trim(); insist(/^[0-7]+$/.test(s), 'invalid-tar-number'); return parseInt(s, 8); };
    const expected = oct(148, 8), actual = [...h].reduce((n, byte, i) => n + (i >= 148 && i < 156 ? 32 : byte), 0);
    insist(actual === expected, 'invalid-tar-checksum');
    const type = str(156, 1), size = oct(124, 12);
    insist(offset + size <= tar.length, 'invalid-artifact-size');
    if (type === 'x') {
      insist(!pax,'nested-tar-metadata'); pax = paxFields(tar.subarray(offset,offset+size));
      offset += Math.ceil(size / 512) * 512; continue;
    }
    const raw = (pax?.path ?? [str(345, 155), str(0, 100)].filter(Boolean).join('/')).replace(/\/$/, '').replace(/^\.\//, '');
    const name = prefix ? prefix + (raw && raw !== '.' ? '/' + raw : '') : raw; pax = null;
    insist(/^dist(?:\/[A-Za-z0-9_@.+ -]+)*$/.test(name) && name.split('/').every(x => x !== '..' && x !== '.') &&
      !seen.has(name) && !str(157, 100) && (type === '0' || type === '' || type === '5') &&
      size <= 64 * 1024 * 1024 && (type !== '5' || size === 0), 'unsafe-artifact-entry');
    seen.add(name); insist(seen.size <= 20000 && offset + size <= tar.length, 'invalid-artifact-size');
    const path = join(destination, name);
    if (type === '5') mkdirSync(path, { recursive: true, mode: 0o755 });
    else {
      const bytes = tar.subarray(offset, offset + size);
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o755 });
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
      files.push({ path: name, size, sha256: digest(bytes) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  insist(ended && tar.subarray(offset).every(x => x === 0) && files.length > 0, 'invalid-artifact-end');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function validateBuildConfig(prepared, emitted) {
  const permitted = new Set([...Object.keys(prepared), 'assets', 'no_bundle', 'find_additional_modules', 'rules']);
  insist(Object.keys(emitted).every(key => permitted.has(key)), 'unexpected-build-configuration');
  for (const key of Object.keys(prepared).filter(k => !['main', '$schema'].includes(k))) {
    const normalize = value => key === 'd1_databases' && Array.isArray(value)
      ? value.map(row => ({ ...row, migrations_dir: posix.resolve('/seed/dist/server', row.migrations_dir) })) : value;
    insist(JSON.stringify(normalize(emitted[key])) === JSON.stringify(normalize(prepared[key])), 'build-target-changed');
  }
  insist(typeof emitted.main === 'string' && posix.resolve('/seed/dist/server', emitted.main) === '/seed/dist/server/index.js' &&
    emitted.no_bundle === true, 'unbound-worker-bundle');
  insist(emitted.assets &&
    Object.keys(emitted.assets).every(key => ['directory', 'binding', 'run_worker_first', 'not_found_handling', 'html_handling'].includes(key)) &&
    typeof emitted.assets.directory === 'string' && posix.resolve('/seed/dist/server', emitted.assets.directory) === '/seed/dist/client', 'unsafe-assets-path');
  insist(emitted.find_additional_modules === undefined || emitted.find_additional_modules === true, 'unsafe-module-discovery');
  for (const rule of emitted.rules ?? []) insist(Object.keys(rule).every(k => ['type', 'globs', 'fallthrough'].includes(k)) &&
    ['ESModule', 'CompiledWasm', 'Text', 'Data', 'JSON'].includes(rule.type) && Array.isArray(rule.globs) &&
    rule.globs.every(p => typeof p === 'string' && !p.startsWith('/') && !p.includes('..')), 'unsafe-module-rule');
}
export function buildIdentity({ sourceSha, files, root, prepared }) {
  const emitted = JSON.parse(readFileSync(join(root, 'dist/server/wrangler.json'), 'utf8'));
  validateBuildConfig(prepared, emitted);
  insist(files.some(f => f.path === 'dist/server/index.js') && files.some(f => f.path === 'dist/client/widget.js'), 'incomplete-build');
  insist(files.every(f => f.path.startsWith('dist/server/') || f.path.startsWith('dist/client/')), 'unexpected-build-file');
  return { sourceSha, artifactSha256: digest(files), configSha256: digest(JSON.stringify(emitted)), files };
}
export function compareModuleBytes(files, downloaded) {
  const expected = files.filter(f => f.path.startsWith('dist/server/') && !f.path.endsWith('/wrangler.json') && !f.path.endsWith('.map'));
  insist(downloaded.size === expected.length, 'serving-module-set-mismatch');
  for (const file of expected) {
    const name = posix.relative('dist/server', file.path), bytes = downloaded.get(name);
    insist(Buffer.isBuffer(bytes) && digest(bytes) === file.sha256, 'serving-module-bytes-mismatch');
  }
}
