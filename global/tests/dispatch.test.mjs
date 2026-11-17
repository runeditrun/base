import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rer = fileURLToPath(new URL('../rer.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [rer, 'door', ...args], { encoding: 'utf8', env: { ...process.env, RER_NO_UPDATE_CHECK: '1' }, timeout: 30_000 });

test('the public door CLI refuses an inherited verb and keeps documented help', () => {
 const refused = run('constructor');
 assert.equal(refused.status, 2);
 assert.equal(refused.stdout, '');
 assert.match(refused.stderr, /Unknown .*door command: constructor/);
 assert.match(refused.stderr, /~\/\.local\/bin\/rer door --help/);
 const help = run('--help');
 assert.equal(help.status, 0);
 assert.match(help.stdout, /rer door enable/);
 assert.equal(help.stderr, '');
});
