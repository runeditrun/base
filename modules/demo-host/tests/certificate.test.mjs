import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createSecureContext } from 'node:tls';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { awaitCertificates } from '../certificate.mjs';

const openssl = (cwd, ...args) => promisify(execFile)('openssl', args, { cwd });

// The provider edge is fake: a TLS listener that, like a new Custom Domain,
// fails every handshake until its certificate is issued, and public DNS that
// does not know a new name at first. The client's verification is real.
test('the demo deploy waits through a missing certificate and never takes a failed handshake for success', async t => {
 const folder = await mkdtemp(join(tmpdir(), 'rer-demo-certificate-'));
 t.after(() => rm(folder, { recursive: true, force: true }));
 await openssl(folder, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test edge CA');
 await openssl(folder, 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'host.key', '-out', 'host.csr', '-subj', '/CN=demo.run-test.example');
 await writeFile(join(folder, 'names.ext'), 'subjectAltName=DNS:demo.run-test.example,DNS:page.demo.run-test.example\n');
 await openssl(folder, 'x509', '-req', '-in', 'host.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'host.pem', '-days', '2', '-extfile', 'names.ext');
 const ca = await readFile(join(folder, 'ca.pem')), issued = createSecureContext({ key: await readFile(join(folder, 'host.key')), cert: await readFile(join(folder, 'host.pem')) });
 const handshakes = {}, issueAfter = { 'demo.run-test.example': 3 };
 const edge = createServer({ SNICallback: (name, done) => {
  handshakes[name] = (handshakes[name] ?? 0) + 1;
  // Before issuance the edge has no certificate for the name; a stray name only ever gets another host's.
  if (name === 'stray.run-test.example' || handshakes[name] > (issueAfter[name] ?? 0)) done(null, issued);
  else done(new Error('no certificate yet'));
 } }, socket => socket.end());
 await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
 t.after(() => edge.close());
 const lookups = {};
 const resolve = async name => (lookups[name] = (lookups[name] ?? 0) + 1) > 2 || name !== 'page.demo.run-test.example' ? '127.0.0.1' : null;
 const lines = [], options = { resolve, port: edge.address().port, ca, interval: 20, timeout: 5000, report: line => lines.push(line) };

 await awaitCertificates({ ...options, hostnames: ['demo.run-test.example', 'page.demo.run-test.example'] });
 assert.equal(handshakes['demo.run-test.example'], 4);
 assert.equal(handshakes['page.demo.run-test.example'], 1);
 assert.equal(lines.filter(line => line.startsWith('Waiting for the certificate on demo.run-test.example')).length, 3);
 assert.equal(lines.filter(line => line.startsWith('Waiting for the certificate on page.demo.run-test.example')).length, 2);
 assert.match(lines.find(line => line.startsWith('TLS on demo.run-test.example verified')), /TLSv1\.[23]/);
 assert.ok(lines.at(-1).startsWith('TLS on '), lines.join('\n'));

 // A certificate that does not verify for the name ends the wait as a failure, naming what the host answered.
 const refused = await awaitCertificates({ ...options, timeout: 300, hostnames: ['stray.run-test.example'] }).then(() => null, error => error);
 assert.equal(refused?.message, 'demo-certificate-timeout');
 assert.deepEqual(refused.hosts, ['stray.run-test.example: ERR_TLS_CERT_ALTNAME_INVALID']);
 assert.ok(handshakes['stray.run-test.example'] > 1);
 assert.ok(!lines.some(line => line.startsWith('TLS on stray')));
});
