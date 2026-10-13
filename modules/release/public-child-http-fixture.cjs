// Test-only curl adapter. Git itself produces every advertisement and pack;
// scanner policy, protocol parsing, object import and inspection remain real.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTransportState } = require('./public-child-transport-state.cjs');
const CONFIG_LIMIT = 65536, REQUEST_LIMIT = 1024 * 1024, RESPONSE_LIMIT = 64 * 1024 * 1024;
const switches = new Set(['silent', 'globoff', 'compressed', 'netrc-optional', 'anyauth', 'location']);
const values = new Set(['header', 'user-agent', 'url', 'output', 'dump-header', 'max-time', 'write-out', 'max-redirs', 'data-binary']);

function boundedRead(fd, limit) {
  const chunks = [], buffer = Buffer.alloc(16384);
  let size = 0, length;
  while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) {
    if ((size += length) > limit) throw Error('Fixture transport input exceeds limit');
    chunks.push(Buffer.from(buffer.subarray(0, length)));
  }
  return Buffer.concat(chunks);
}

exports.installHttpFixture = function (directory, configPath) {
  fs.writeFileSync(path.resolve(directory, 'curl'), '#!/usr/bin/env node\n' +
    `try { require(${JSON.stringify(__filename)}).serve(${JSON.stringify(configPath)}); }\n` +
    'catch { process.stderr.write("Fixture HTTP transport rejected request\\n"); process.exitCode = 1; }\n', { mode: 0o755 });
};

exports.serve = function (configPath) {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--disable', '--config', '-'])) throw Error('Unsupported curl invocation');
  const config = JSON.parse(fs.readFileSync(configPath));
  const options = new Map();
  for (const line of boundedRead(0, CONFIG_LIMIT).toString('utf8').split('\n').filter(Boolean)) {
    const match = /^([a-z-]+)(?: = (".*"))?$/.exec(line);
    if (!match) throw Error('Unsupported curl config');
    const [, key, raw] = match;
    if (raw === undefined ? !switches.has(key) : !values.has(key)) throw Error('Unsupported curl option');
    if (options.has(key) && key !== 'header') throw Error('Duplicate curl option');
    const value = raw === undefined ? true : JSON.parse(raw);
    if (typeof value !== 'string' && value !== true) throw Error('Invalid curl value');
    options.set(key, value);
  }
  const url = options.get('url'), data = options.get('data-binary');
  const advertise = url === config.url + '/info/refs?service=git-upload-pack' && data === undefined;
  const exchange = url === config.url + '/git-upload-pack' && typeof data === 'string' && data.startsWith('@');
  if (!advertise && !exchange) throw Error('Unknown fixture URL or method');
  if (options.get('write-out') !== '%{http_code}\n%{content_type}\n%{url_effective}\n') throw Error('Unsupported metadata format');
  const timeout = Number(options.get('max-time')) * 1000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 7200000) throw Error('Invalid timeout');
  for (const key of ['output', 'dump-header']) {
    if (typeof options.get(key) !== 'string' || !path.isAbsolute(options.get(key))) throw Error('Expected output file');
  }
  let input;
  if (exchange) {
    const fd = fs.openSync(data.slice(1), 'r');
    try { input = boundedRead(fd, REQUEST_LIMIT); } finally { fs.closeSync(fd); }
  }
  withTransportState(config.state, state => { if (advertise) state.fetches++; }, () => {
    const result = spawnSync(config.actualGit, ['upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), config.bare],
      { input, encoding: null, timeout: Math.min(timeout, 15000), maxBuffer: RESPONSE_LIMIT, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw Error('Native upload-pack failed');
    const body = advertise ? Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), result.stdout]) : result.stdout;
    if (body.length > RESPONSE_LIMIT) throw Error('Fixture transport response exceeds limit');
    const type = 'application/x-git-upload-pack-' + (advertise ? 'advertisement' : 'result');
    fs.writeFileSync(options.get('output'), body);
    fs.writeFileSync(options.get('dump-header'), `HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(`200\n${type}\n${url}\n`);
  });
};
