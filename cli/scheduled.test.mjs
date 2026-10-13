import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { declaredCrons } from './scheduled.mjs';

test('declaredCrons reads JSONC without changing strings or joining tokens and rejects malformed config', async () => {
 const root = mkdtempSync(join(tmpdir(), 'declared-crons-'));
 const cron = '1,2 * * * *';
 try {
  assert.deepEqual(await declaredCrons(root), []);
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
   const file = join(root, name);
   const valid = `{
    // Cron list and quoted punctuation must survive comment and comma removal.
    "triggers": {"crons": [${JSON.stringify(cron)}, /* list end */],},
    "text": ${JSON.stringify('/* quoted */ // ,} ,] \\" escaped "')},
    "objects": [1, {"a": true,},],
    "values": [-0, -12.5e+2, 0.125E-2, true, false, null],
   } // EOF comment`;
   writeFileSync(file, valid);
   assert.deepEqual(await declaredCrons(root), [cron]);
   for (const text of ['{"triggers": {"crons": []}}/* EOF block */', '{}', '{"triggers":{}}']) {
    writeFileSync(file, text);
    assert.deepEqual(await declaredCrons(root), []);
   }
   for (const text of [
    String.raw`{"escapes":"\u0041\t\n\r\b\f\/\"\\"}`,
    `{"nested":${'['.repeat(20000)}0${']'.repeat(20000)}}`,
   ]) {
    writeFileSync(file, text);
    assert.deepEqual(await declaredCrons(root), []);
   }
   const malformed = [
    ['{"triggers":{"crons":["* * * * *', 'Unterminated string', 22, 1, 23],
    ['{/*', 'Unterminated block comment', 1, 1, 2],
    ['{\n /* comment */\n "text": "escape\\', 'Unterminated string', 26, 3, 10],
    ['{\n /* unfinished', 'Unterminated block comment', 3, 2, 2],
    ['', 'Unexpected end', 0, 1, 1], [' \n', 'Unexpected end', 2, 2, 1],
    ['/* EOF comment */', 'Unexpected end', 17, 1, 18],
    ['{"number":1/* gap */2}', undefined, 20, 1, 21],
    ['{"number":1// gap\n2}', undefined, 18, 2, 1],
    ['{"items":[,]}', undefined, 10, 1, 11], ['{,}', undefined, 1, 1, 2],
    ['{"items":[1,,]}', undefined, 12, 1, 13],
    ['{"note":undefined}', undefined, 8, 1, 9], ['x', undefined, 0, 1, 1],
    ['{"text":"undefined","note":undefined}', undefined, 27, 1, 28],
    ['{"text":"💥 undefined","note":undefined}', undefined, 30, 1, 31],
    ['{"text":"%","note":%}', undefined, 19, 1, 20],
    ['{\n "text":"undefined",\n "note":undefined\n}', undefined, 31, 3, 9],
    ['{"note";0}', undefined, 7, 1, 8], ['{"a",}', undefined, 4, 1, 5],
    ['{"a":;}', undefined, 5, 1, 6], ['{"a":truX}', undefined, 8, 1, 9],
    ['{"a":[true false]}', undefined, 11, 1, 12], ['{"a":]}', undefined, 5, 1, 6],
    ['{"a":01}', undefined, 6, 1, 7], ['{"a":1e+}', undefined, 8, 1, 9],
    ['{"a":"\\q"}', undefined, 7, 1, 8], ['{"a":"\\u12Z4"}', undefined, 10, 1, 11],
    ['{"a":"line\nbreak"}', undefined, 10, 1, 11],
    ['{"triggers":{"crons":false}}'], ['{"triggers":{"crons":[7]}}'],
   ];
   for (const [text, message, position, line, column] of malformed) {
    writeFileSync(file, text);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
     `import {declaredCrons} from ${JSON.stringify(new URL('./scheduled.mjs', import.meta.url).href)};
      try { await declaredCrons(process.argv[1]); process.exitCode = 2; }
      catch (error) { console.log(error.message); }`, root], {encoding: 'utf8'});
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${name}: ${text}`);
    assert.ok(result.stdout.includes(name), result.stdout);
    if (message) assert.ok(result.stdout.includes(message), result.stdout);
    if (position !== undefined) {
     assert.match(result.stdout, new RegExp(`position ${position} \\(line ${line} column ${column}\\)`));
    }
   }
   rmSync(file);
  }
  assert.deepEqual(await declaredCrons(root), []);
 } finally { rmSync(root, {recursive: true, force: true}); }
});

test('declaredCrons reads wrangler.toml and deploy templates and refuses two files that declare different schedules', async () => {
 const root = mkdtempSync(join(tmpdir(), 'declared-crons-toml-'));
 try {
  mkdirSync(join(root, 'deploy'));
  const template = join(root, 'deploy/wrangler.template.toml');
  writeFileSync(template, 'name = "x"\n\n[triggers]\ncrons = [\n "* * * * *", # every minute\n "0 3 * * *",\n]\n\n[env.staging.triggers]\ncrons = ["9 9 * * *"]\n');
  assert.deepEqual(await declaredCrons(root), ['* * * * *', '0 3 * * *']);
  writeFileSync(join(root, 'wrangler.jsonc'), '{"triggers": {"crons": ["0 3 * * *", "* * * * *"]}}');
  assert.deepEqual((await declaredCrons(root)).sort(), ['* * * * *', '0 3 * * *']);
  writeFileSync(join(root, 'wrangler.jsonc'), '{"triggers": {"crons": ["*/10 * * * *"]}}');
  await assert.rejects(declaredCrons(root), error => error.message.includes('wrangler.jsonc') && error.message.includes('deploy/wrangler.template.toml') && error.message.includes('*/10 * * * *') && error.message.includes('0 3 * * *'));
  writeFileSync(join(root, 'wrangler.jsonc'), '{"main": "src/x.ts"}');
  assert.deepEqual(await declaredCrons(root), ['* * * * *', '0 3 * * *']);
 } finally { rmSync(root, {recursive: true, force: true}); }
});
