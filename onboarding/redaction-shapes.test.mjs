import { randomBytes } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommands } from './commands.mjs';
import { createRedaction, credentialValues } from './redaction.mjs';

const awsSecret = randomBytes(24).toString('base64');
const apiSecret = randomBytes(24).toString('base64');
const MASK = '[REDACTED]';
const basic = value => Buffer.from(value).toString('base64');
const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.test-signature';
const quotedCredential = 'test ' + 'opaque-synthetic-fragment '.repeat(30) + 'end';
const longJwt = 'eyJ' + 'a'.repeat(750) + '.' + 'b'.repeat(750) + '.test-long-signature';

// Each row: [shape, text, private parts that must never reach output, optional exact output].
const secretShapes = [
 ['prefixed password assignment', 'DB_PASSWORD=test-hunter2value', ['hunter2value']],
 ['prefixed token assignment', 'GITHUB_TOKEN=test-abcdef123456', ['abcdef123456']],
 ['snake-case client secret', 'client_secret=abc123xyz', ['abc123xyz']],
 ['prefixed secret with colon', 'MY_SECRET: abc123xyz', ['abc123xyz']],
 ['client secret query parameter', 'https://h/?client_secret=abc', ['secret=abc']],
 ['prefixed key assignment', 'AWS_SECRET_ACCESS_KEY=synthetic-access-value', ['synthetic-access-value']],
 ['quoted prefixed api key', 'STRIPE_API_KEY="synthetic-stripe-value"', ['synthetic-stripe-value']],
 ['dashed api key header', 'x-api-key: synthetic-header-value', ['synthetic-header-value']],
 ['prefixed auth assignment', 'NPM_AUTH=synthetic-npm-auth', ['synthetic-npm-auth']],
 ['prefixed pass assignment', 'SMTP_PASS=synthetic-smtp-pass', ['synthetic-smtp-pass']],
 ['prefixed dsn assignment', 'SENTRY_DSN=https://synthetic-dsn-key@o1.ingest.invalid/1', ['synthetic-dsn-key']],
 ['prefixed pat assignment', 'GITLAB_PAT=synthetic-gitlab-pat', ['synthetic-gitlab-pat']],
 ['prefixed sig assignment', 'AZURE_STORAGE_SIG=synthetic-azure-sig', ['synthetic-azure-sig']],
 ['dashed token field', 'my-token: synthetic-dash-token', ['synthetic-dash-token']],
 ['JSON client secret', '{"client_secret":"synthetic-json-secret"}', ['synthetic-json-secret']],
 ['command-line password flag', '--password=synthetic-cli-pass', ['synthetic-cli-pass']],
 ['separate command-line token argument', '--token test-synthetic-cli-token', ['synthetic-cli-token']],
 ['unspaced token colon', 'token:synthetic-colon-token', ['synthetic-colon-token']],
 ['Authorization Basic without digits', 'Authorization: Basic ' + basic('user:pass'), [basic('user:pass')]],
 ['quoted Authorization Bearer', "curl -H 'Authorization: Bearer test-abcdefghijkl'", ['abcdefghijkl']],
 ['bare Basic credential', 'Basic ' + basic('sample:synthetic-basic'), [basic('sample:synthetic-basic')]],
 ['bare Bearer credential', 'Bearer synthetic-bearer-token-123', ['synthetic-bearer-token-123']],
 ['userinfo password containing @', 'postgres://user:p@ss@db.invalid/db', ['p@ss', 'ss@db']],
 ['userinfo password containing /', 'postgres://user:pa/ss@db.invalid/db', ['pa/ss']],
 ['userinfo with empty user', 'redis://:synthetic-redis-pass@cache.invalid:6379', ['synthetic-redis-pass']],
 ['https userinfo', 'https://url-user:synthetic-url-pass@host.invalid/path', ['synthetic-url-pass']],
 ['amqp userinfo', 'amqp://guest:synthetic-rabbit@mq.invalid', ['synthetic-rabbit']],
 ['sig query parameter', 'https://h.invalid/x?sig=synthetic-sig-value&safe=1', ['synthetic-sig-value']],
 ['signature query parameter', 'https://h.invalid/x?signature=synthetic-signature', ['synthetic-signature']],
 ['key query parameter', 'https://h.invalid/x?key=synthetic-key-value', ['synthetic-key-value']],
 ['access token query parameter', 'https://h.invalid/x?access_token=synthetic-access', ['synthetic-access']],
 ['api key query parameter', 'https://h.invalid/x?api_key=synthetic-api-key', ['synthetic-api-key']],
 ['PEM private key', '-----BEGIN EC PRIVATE KEY-----\nTEST_SYNTHETIC_PEM_BODY\n-----END EC PRIVATE KEY-----', ['SYNTHETIC_PEM_BODY']],
 ['GitHub token prefix', 'ghp_TEST_SYNTHETICGITHUBTOKEN', ['SYNTHETICGITHUBTOKEN']],
 ['JWT', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.test-signature', ['eyJzdWIiOiJzeW50aGV0aWMifQ']],
 // Credential shapes: camelCase credential fields, quoted values with spaces, other
 // Authorization schemes, cookies, PGP blocks and more provider prefixes.
 // JWTs need no word boundary before their header.
 ...['session-', 'session_', 'x', 'x-', '9'].flatMap(prefix => [
  [`JWT after ${prefix}`, `${prefix}${jwt} end`, ['test-signature'], `${prefix}${MASK} end`],
  [`long JWT after ${prefix}`, `${prefix}${longJwt} end`, ['test-long-signature'], `${prefix}${MASK} end`],
 ]),
 ['long quoted camelCase token', `refreshToken="${quotedCredential}"`, ['opaque-synthetic-fragment']],
 ['long quoted acronym token', `APIToken='${quotedCredential}'`, ['opaque-synthetic-fragment']],
 ['long quoted CLI token', `--token "${quotedCredential}"`, ['opaque-synthetic-fragment']],
 ['long quoted password', `PASSWORD="${quotedCredential}"`, ['opaque-synthetic-fragment']],
 ['escaped quote in camel token', `refreshToken=${JSON.stringify('test "' + quotedCredential)}`, ['opaque-synthetic-fragment']],
 ['escaped quote in CLI token', "--token 'test \\'" + quotedCredential + "'", ['opaque-synthetic-fragment']],
 ['camel token after long whitespace', 'refreshToken:' + ' '.repeat(700) + 'test-synthetic-gap-credential', ['synthetic-gap-credential']],
 ['acronym token after long whitespace', 'APIToken:' + ' '.repeat(700) + 'test-synthetic-gap-credential', ['synthetic-gap-credential']],
 ['CLI token after long whitespace', '--token' + ' '.repeat(700) + 'test-synthetic-gap-credential', ['synthetic-gap-credential']],
 ['flag prefix inside an opaque password', 'PASSWORD=' + ' '.repeat(700) + 'true-synthetic-gap-credential', ['synthetic-gap-credential']],
 ['acronym API token', 'APIToken=test-synthetic-api-token', ['synthetic-api-token']],
 ['acronym AWS secret key', `AWSSecretKey=${awsSecret}`, [awsSecret]],
 ['acronym API secret', `APISecret=${apiSecret}`, [apiSecret]],
 ['acronym API password', 'APIPassword=test-synthetic-api-password', ['synthetic-api-password']],
 ...['primaryKey', 'skipAuth', 'cachePass', 'nextToken'].map(name => [`secret-like ${name}`, `${name}: test-synthetic-credential`, ['synthetic-credential']]),
 ...['key', 'auth', 'pass', 'token'].map(name => [`secret-like CLI ${name}`, `--${name} test-synthetic-credential`, ['synthetic-credential']]),
 ['camelCase refresh token JSON', '{"refreshToken":"test-synthetic-refresh"}', ['synthetic-refresh']],
 ['camelCase client secret', 'clientSecret=test-synthetic-client', ['synthetic-client']],
 ['camelCase private key JSON', '"privateKey": "test-synthetic-private"', ['synthetic-private']],
 ['camelCase database password', 'dbPassword=test-synthetic-dbpass', ['synthetic-dbpass']],
 ['camelCase id token', '{"idToken":"test-synthetic-idtoken"}', ['synthetic-idtoken']],
 ['camelCase session token assignment', 'sessionToken=test-synthetic-session', ['synthetic-session']],
 ['Azure account key', 'AccountName=fixture;AccountKey=test-synthetic-azure-account;EndpointSuffix=core.invalid', ['synthetic-azure-account']],
 ['quoted password with spaces', 'PASSWORD="test synthetic two words"', ['synthetic two words', 'two words']],
 ['single-quoted secret with spaces', "client_secret='test synthetic quoted'", ['synthetic quoted']],
 ['Authorization token scheme', 'Authorization: token test-synthetic-scheme', ['synthetic-scheme']],
 ['Authorization Digest response', 'Authorization: Digest username="fixture", response="test-synthetic-digest"', ['synthetic-digest']],
 ['PGP private key block', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nTEST_SYNTHETIC_PGP_BODY\n-----END PGP PRIVATE KEY BLOCK-----', ['SYNTHETIC_PGP_BODY']],
 ['Hugging Face token prefix', 'hf_TEST_SYNTHETICHUGGINGFACE', ['SYNTHETICHUGGINGFACE']],
 ['live publishable key prefix', 'pk_live_TEST_SYNTHETICPUBLISHABLE', ['SYNTHETICPUBLISHABLE']],
 ['Cookie header', 'Cookie: session=test-synthetic-cookie; theme=dark', ['synthetic-cookie']],
 ['Set-Cookie header', 'Set-Cookie: auth=test-synthetic-setcookie; Path=/; HttpOnly', ['synthetic-setcookie']],
];

// Registered values printed as a re-encoding or a part of themselves.
const registered = 'synthetic"quote\\back\nline-42';
const hex = Buffer.from(registered).toString('hex');
const registeredShapes = [
 ['explicit short camelCase credential', ['tiny'], 'APIToken=tiny', ['tiny']],
 ['explicit short CLI credential', ['tiny'], '--token tiny', ['tiny']],
 ['JSON-escaped registered value', [registered], JSON.stringify(registered).slice(1, -1), ['synthetic\\"quote']],
 ['double URL-encoded registered value', [registered], encodeURIComponent(encodeURIComponent(registered)), ['synthetic%2522quote']],
 ['lowercase hex registered value', [registered], hex, [hex.slice(0, 24)]],
 ['uppercase hex registered value', [registered], hex.toUpperCase(), [hex.toUpperCase().slice(0, 24)]],
 ['CRLF registered value', [registered], registered.replace('\n', '\r\n'), ['synthetic"quote', 'line-42']],
 ['ASCII JSON-escaped registered value', ['synthetic-p\u00e4ss-value'], 'synthetic-p\\u00e4ss-value', ['synthetic-p\\u00e4ss']],
 ['HTML-escaped registered value', [registered], 'synthetic&quot;quote\\back\nline-42', ['synthetic&quot;quote']],
 ['shell-quoted registered value', ["test-synthetic'quoted-value"], "'test-synthetic'\\''quoted-value'", ["synthetic'\\''quoted"]],
 ['uppercase Unicode registered value', ['test-synthetic-\u00e9-value'], 'TEST-SYNTHETIC-\u00c9-VALUE', ['SYNTHETIC-\u00c9']],
 ['trimmed registered value', ['  padded-synthetic-value \n'], 'padded-synthetic-value', ['padded-synthetic-value']],
 ['password of a registered URL', credentialValues({ DATABASE_URL: 'postgres://u:synthetic-db-pass@db.invalid/app' }), 'password synthetic-db-pass', ['synthetic-db-pass']],
 ['decoded password of a registered URL', credentialValues({ DATABASE_URL: 'postgres://u:test-pa%40ss-9@db.invalid/app' }), 'password test-pa@ss-9', ['pa@ss-9']],
];

// Diagnostic prose: complete text and a final unterminated line stay exact.
const prose = [
 'Tests pass', 'Please enter the key', 'Setting auth', 'Preparing operator auth', 'Basic checks passed',
 'Use Basic authentication', 'Bearer tokens are required', 'Bearer auth is configured', 'Copy the token',
 'Store the secret', 'Generate a GitHub pat', 'Enter the pass', 'Signing with sig', 'Waiting for signature',
 'Check the dsn', 'Paste your API key', 'Preparing token', '-----END CERTIFICATE-----', '-----BEGIN CERTIFICATE-----',
 '----', '-----', 'Section ----', 'Ready at http://localhost:8787', 'Open https://example.invalid',
 'Vite loaded http://localhost:5173/@vite/client', 'Fetched https://registry.npmjs.org/@scope/pkg',
 'Opened http://[::1]:8787/@fs/app', 'Mirror https://registry.invalid:4873/@scope/pkg@1.2.3', 'exit 1, signal none',
 'Log: /tmp/run/install.log', '# pass 151', 'ok 3 - tokens pass', 'SKIP_AUTH is unset', 'max_tokens 4096 accepted',
 // Public text: flags after credential-shaped names, slashes after Basic or
 // Bearer, and camelCase words that are not credential fields.
 'SKIP_AUTH=1', 'DISABLE_AUTH=true', 'USE_PASS=0', 'NO_KEY=1', 'ENABLE_SIG=false', 'hasToken=true', 'isAuth: false', 'hasToken=TRUE',
 'primaryKey: id', 'primaryKey=42', 'skipAuth: true', 'skipAuth: basic', 'cachePass: 2', 'nextToken: next',
 'primaryKey:' + ' '.repeat(700) + 'id',
 'primaryKey:' + ' '.repeat(700) + '"id"',
 'nextToken:' + ' '.repeat(700) + 'next',
 '--token' + ' '.repeat(700) + 'next',
 'primaryKey: "id"', "nextToken='next'", 'APIToken: next',
 '--key id', '--auth basic', '--pass 2', '--token next',
 'Basic usage/options', 'Bearer /path/to/config', 'Basic installation/uninstallation guide', 'maxTokens: 4096', 'Keyboard layout: us',
];

function streamed(redaction, text, unit) {
 let output = ''; const stream = redaction.stream(chunk => { output += chunk; });
 const bytes = Buffer.from(text);
 for (let offset = 0; offset < bytes.length; offset += unit) stream.write(bytes.subarray(offset, offset + unit));
 stream.end(); return output;
}
function privateOutput(output, privateParts) {
 for (const part of privateParts) assert.ok(!output.includes(part), 'private bytes reached output');
 assert.ok(output.includes(MASK), 'no redaction marker');
}

// Run every row and report all failing shapes together.
function eachRow(rows, check) {
 const failures = [];
 for (const row of rows) try { check(...row); } catch (error) { failures.push(`${row[0]}: ${error.message.split('\n')[0]}`); }
 assert.deepEqual(failures, []);
}

test('table: secret-bearing shapes redact in complete text, byte-split streams and long lines', () => {
 assert.ok(secretShapes.length + registeredShapes.length + prose.length >= 110);
 eachRow(secretShapes, (shape, text, privateParts, exactOutput) => {
  const redaction = createRedaction();
  const outputs = [redaction.redact(`BEFORE_MARKER ${text} AFTER_MARKER`), redaction.redact(text)];
  // Whole, byte-split, and on a line long enough to leave the line hold window.
  for (const unit of [1, 3, 4096]) outputs.push(streamed(redaction, `BEFORE_MARKER\n${text}\nAFTER_MARKER\n`, unit), streamed(redaction, text, unit));
  outputs.push(streamed(redaction, 'context '.repeat(60) + text + '\n', 1));
  for (const output of outputs) privateOutput(output, privateParts);
  // The JWT regression matrix shares these whole-text and stream calls. Keep
  // its stronger assertion: redact the token without changing adjacent text.
  if (exactOutput !== undefined) {
   for (const index of [1, 3, 5, 7]) assert.equal(outputs[index], exactOutput, `${shape}: JWT leaked or nearby diagnostics changed (${index === 1 ? 'whole text' : [1, 3, 4096][(index - 3) / 2] + '-byte stream'})`);
  }
  for (const output of [outputs[0], outputs[2]]) { assert.match(output, /BEFORE_MARKER/); assert.match(output, /AFTER_MARKER/); }
 });
});

test('table: re-encodings and parts of registered values redact', () => {
 eachRow(registeredShapes, (shape, secrets, text, privateParts) => {
  const redaction = createRedaction(); redaction.addSecrets(secrets);
  privateOutput(redaction.redact(`BEFORE_MARKER ${text} AFTER_MARKER`), privateParts);
  for (const unit of [1, 4096]) {
   const output = streamed(redaction, `BEFORE_MARKER\n${text}\nAFTER_MARKER\n`, unit);
   privateOutput(output, privateParts); assert.match(output, /BEFORE_MARKER/); assert.match(output, /AFTER_MARKER/);
  }
 });
});

test('table: diagnostic prose stays intact as complete text and as a final unterminated line', () => {
 eachRow(prose.map(text => [text]), text => {
  const redaction = createRedaction();
  assert.equal(redaction.redact(text), text);
  for (const unit of [1, 4096]) {
   assert.equal(streamed(redaction, text, unit), text, 'final unterminated line was changed');
   assert.equal(streamed(redaction, `${text}\n`, unit), `${text}\n`);
  }
 });
});

test('step labels, reports and a final unterminated child line reach every sink unchanged', async t => {
 const root = await mkdtemp(join(tmpdir(), 'redaction-shapes-')); const state = { logs: [] }; let terminal = '';
 const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
 const store = await createCommands(root, state, { spawn: () => child, terminal: text => { terminal += text; } });
 t.after(async () => { await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 store.report('Preparing operator auth');
 const running = store.run('Basic checks passed', 'unused');
 child.stdout.write('DB_PASSWORD=test-hunter2value\nTests pass');
 child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); await running;
 assert.equal(state.step, 'Basic checks passed');
 for (const output of [terminal, state.logs.join('\n'), await readFile(store.logPath, 'utf8')]) {
  for (const line of ['Preparing operator auth', 'Basic checks passed', 'DB_[REDACTED]', 'Tests pass']) assert.ok(output.includes(line), `missing ${line}`);
  assert.ok(!output.includes('hunter2value'));
 }
});

test('credential variable names are whole word parts, so ordinary variables are not registered', () => {
 const ordinary = { PATH: '/usr/local/bin:/usr/bin:/bin', DESIGN_MODE: 'production-mode', SIGNAL_NAME: 'termination', KEYBOARD_LAYOUT: 'english-us', COMPASS_DIR: '/opt/compass', AUTHOR_NAME: 'Fixture Author' };
 assert.deepEqual(credentialValues(ordinary), []);
 const credentials = { GITHUB_TOKEN: 'test-synthetic-1', DB_PASSWORD: 'test-synthetic-2', apiKey: 'test-synthetic-3', clientSecret: 'test-synthetic-4', AWS_SECRET_ACCESS_KEY: 'test-synthetic-5', APIKEY: 'test-synthetic-6', PASSWD: 'test-synthetic-7', SESSION_COOKIE: 'test-synthetic-8', SECRETS: 'test-synthetic-9', TOKEN: 'test-synthetic-10' };
 assert.deepEqual(credentialValues(credentials), Object.values(credentials));
 const redaction = createRedaction(); redaction.addSecrets(credentialValues(ordinary));
 assert.equal(redaction.redact('Building in production-mode for english-us'), 'Building in production-mode for english-us');
});

// Pathological 4 MiB inputs must cost about as much as ordinary output of the
// same size: adjacent \s* runs and JWT runs used to backtrack quadratically.
test('4 MiB pathological inputs redact in time comparable to ordinary output', () => {
 const size = 4 * 1024 * 1024;
 const time = text => {
  const redaction = createRedaction(); let started = Date.now();
  const stream = redaction.stream(() => {});
  for (let index = 0; index < text.length; index += 4096) stream.write(text.slice(index, index + 4096));
  stream.end(); const streamed = Date.now() - started;
  started = Date.now(); redaction.redact(text); return Math.max(streamed, Date.now() - started);
 };
 const ordinary = time('Compiled module ok in 12ms at http://localhost:5173/src/app.tsx\n'.repeat(size / 64));
 const budget = Math.max(2000, ordinary * 8);
 for (const [name, text] of [
  ['field name before long spaces', ('key' + ' '.repeat(5000) + 'x\n').repeat(Math.floor(size / 5005))],
  ['dotted eyJ run', 'eyJ.'.repeat(size / 4)],
  ['dashed eyJ run', 'eyJ-'.repeat(size / 4)],
 ]) {
  const elapsed = time(text);
  assert.ok(elapsed < budget, `${name}: ${elapsed} ms against ${budget} ms (ordinary ${ordinary} ms)`);
 }
});


test('acronym-prefixed credential variables register their values', () => {
 const values = { APIToken: 'test-synthetic-api-token', AWSSecretKey: 'test-synthetic-aws-key', APISecret: 'test-synthetic-api-secret', APIPassword: 'test-synthetic-api-password' };
 assert.deepEqual(credentialValues(values), Object.values(values));
});

test('camelCase prefix and JWT holds protect long values split beyond the output window', () => {
 for (const [name, prefix, value, suffix, privatePart] of [
  ['camelCase', 'refreshToken:' + ' '.repeat(700), 'test-synthetic-refresh-' + 'a'.repeat(700), ' end', 'synthetic-refresh'],
  ['acronym', 'APIToken:' + ' '.repeat(700), 'test-synthetic-api-' + 'a'.repeat(700), ' end', 'synthetic-api'],
  ['JWT', 'xeyJ' + 'a'.repeat(750), '.' + 'b'.repeat(750) + '.test-split-signature', ' end', 'test-split-signature'],
 ]) {
  const redaction = createRedaction(); let output = '';
  const stream = redaction.stream(chunk => { output += chunk; });
  stream.write('BEFORE_MARKER ' + prefix);
  assert.ok(!output.includes(prefix.trim()), `${name} prefix escaped the hold`);
  stream.write(value); stream.write(suffix); stream.end();
  privateOutput(output, [privatePart]); assert.match(output, /BEFORE_MARKER/); assert.match(output, / end$/);
 }
});

test('oversized quoted credentials stay bounded and private until their closing quote', () => {
 for (const prefix of ['refreshToken="', "APIToken='", '--token "']) {
  const quote = prefix.at(-1), redaction = createRedaction(); let output = '';
  const stream = redaction.stream(chunk => { output += chunk; });
  stream.write('BEFORE_MARKER ' + prefix);
  // Enter bounded discard with a trailing escape, then split its quote.
  stream.write('opaque-synthetic-fragment '.repeat(600));
  stream.write('opaque-synthetic-fragment '.repeat(80) + '\\');
  stream.write(quote + 'opaque-synthetic-fragment ');
  assert.ok(!(output + stream.snapshot()).includes('opaque-synthetic-fragment'));
  for (let index = 0; index < 12; index++) {
   stream.write('opaque-synthetic-fragment '.repeat(160));
   if (index === 5) {
    stream.write('\\'); stream.write(quote + 'opaque-synthetic-fragment ');
   }
   assert.ok(stream.bufferedLength < 17000);
   assert.ok(!(output + stream.snapshot()).includes('opaque-synthetic-fragment'), 'quoted private bytes reached output');
  }
  stream.write(quote + ' AFTER_MARKER'); stream.end();
  assert.match(output, /BEFORE_MARKER/); assert.match(output, /AFTER_MARKER/);
  assert.ok(!output.includes('opaque-synthetic-fragment'));
 }
});
