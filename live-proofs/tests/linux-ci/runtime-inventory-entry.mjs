// Runs only inside the freshly built credential-free image.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const role = process.argv[2], prefix = role === 'browser' ? '/opt/browser' : '/opt/trusted';
const walk = path => fs.readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path + '/' + e.name) : e.isFile() ? [path + '/' + e.name] : []);
const locks = walk(prefix).filter(p => p.endsWith('/package-lock.json') || p.endsWith('/.package-lock.json')).map(path => ({ path, sha256: hash(path), lock: JSON.parse(fs.readFileSync(path)) }));
const executables = ['/usr/local/bin/node'];
if (role !== 'browser') executables.push('/opt/trusted/node_modules/pnpm/bin/pnpm.cjs');
if (role === 'controller') executables.push('/opt/trusted/node_modules/wrangler/bin/wrangler.js');
let browser;
if (role === 'browser') {
  const files = walk('/opt/browsers').filter(p => /\/(chrome|headless_shell|chrome-headless-shell|ffmpeg-linux)$/.test(p));
  if (files.length < 3) throw new Error('browser-binaries-missing');
  const { chromium } = await import('/opt/browser/node_modules/playwright/index.mjs');
  const launched = await chromium.launch({ headless: true });
  let runtime; try { runtime = { version: launched.version(), headless: true }; } finally { await launched.close(); }
  browser = { runtime, manifest: JSON.parse(fs.readFileSync('/opt/browser/node_modules/playwright-core/browsers.json')), binaries: files.map(path => ({ path, sha256: hash(path) })) };
}
console.log(JSON.stringify({ role, platform: process.platform, arch: process.arch, node: process.version,
  uid: process.getuid(), gid: process.getgid(), locks, executables: executables.map(path => ({ path, sha256: hash(path) })), browser,
  packages: execFileSync('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\n'], { encoding: 'utf8' }) }));
