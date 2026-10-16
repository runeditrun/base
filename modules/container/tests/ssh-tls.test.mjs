import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sniProxy } from './ssh-tls-proxy.mjs';
import { host, image, fixture, docker, inspect, running } from './ssh-fixture.mjs';
const execute = promisify(execFile);
const pause = () => new Promise(resolve => setTimeout(resolve, 150));

async function localAuthority(installation, hostname) {
 // Stock Caddy provisions its test-local CA in the same labeled data volume it
 // will use for the real deployment. This replaces only the certificate edge.
 const volume = installation.name + '-caddy';
 const labels = { ...installation.labels, 'io.runeditrun.role': 'caddy' };
 await docker('volume', 'create', ...Object.entries(labels).flatMap(([key, value]) => ['--label', key + '=' + value]), volume);
 const bootstrap = installation.name + '-ca-bootstrap';
 await docker('run', '-d', '--name', bootstrap, '--mount', `type=volume,source=${volume},target=/data`, '--tmpfs', '/config', '--entrypoint', 'sh', 'caddy:2.10.2', '-c', `printf 'https://${hostname} {\n tls internal\n reverse_proxy app:8080\n}\n' > /tmp/Caddyfile; exec caddy run --config /tmp/Caddyfile --adapter caddyfile`);
 try {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
   try { return await docker('exec', bootstrap, 'cat', '/data/caddy/pki/authorities/local/root.crt'); } catch {}
   await pause();
  }
  throw Error('Local Caddy authority did not become ready');
 } finally { await docker('rm', '-f', bootstrap); }
}

test('two public HTTPS CLI installs route through distinct real TLS listeners and preserve trusted ingress', { skip: !host || !image, timeout: 240000 }, async t => {
 const f = await fixture(t), caPath = join(f.root, 'test-ca.pem'), dnsPath = join(f.root, 'test-dns.cjs');
 // Confined network-edge DNS supplies reserved .localhost names to the local
 // fixture. TLS certificate validation remains enabled in CLI and curl.
 await writeFile(dnsPath, `const dns=require('node:dns');const original=dns.lookup;dns.lookup=function(host,options,callback){if(typeof options==='function'){callback=options;options={};}if(host.endsWith('.localhost'))return process.nextTick(callback,null,...(options?.all?[[{address:'127.0.0.1',family:4}]]:['127.0.0.1',4]));return original.apply(this,arguments);};\n`);
 const aHost = 'one.localhost', bHost = 'two.localhost';
 const a = await f.select('https/one', `https://${aHost}:60585`, f.environment, { address: '127.0.0.1', httpPort: 60580, httpsPort: 60581 });
 const caA = await localAuthority(a, aHost);
 const b = await f.select('https/two', `https://${bHost}:60585`, f.environment, { address: '127.0.0.1', httpPort: 60582, httpsPort: 60583 });
 const caB = await localAuthority(b, bHost);
 await writeFile(caPath, caA + '\n' + caB + '\n');
 const proxy = await sniProxy({ [aHost]: 60581, [bHost]: 60583 }, 60585);
 t.after(() => proxy.close());
 const env = { NODE_EXTRA_CA_CERTS: caPath, NODE_OPTIONS: `--require=${dnsPath}` };
 await f.select('https/one', a.origin, f.environment, { address: '127.0.0.1', httpPort: 60580, httpsPort: 60581 });
 await f.cli(a, { env });
 const aId = await running(a);
 await f.select('https/two', b.origin);
 await f.cli(b, { packaged: true, env, extra: ['--bind-address', '127.0.0.1', '--http-port', '60582', '--https-port', '60583'] });
 const bId = await running(b), caddyB = (await inspect('container', b.name + '-caddy')).Id;
 const health = async (installation, hostname, port) => JSON.parse((await execute('curl', ['--fail', '--silent', '--show-error', '--cacert', caPath, '--resolve', `${hostname}:${port}:127.0.0.1`, installation.origin + '/health'], { timeout: 15000 })).stdout);
 assert.equal((await health(a, aHost, 60585)).platform, 'container');
 assert.equal((await health(b, bHost, 60585)).platform, 'container');
 assert.equal(await running(a), aId);
 for (const installation of [a, b]) {
  for (const [kind, roles] of [['container', ['app', 'caddy']], ['volume', ['data', 'caddy', 'caddy-config']], ['network', ['ingress']]]) for (const role of roles) {
   const item = await inspect(kind, installation.name + '-' + role), labels = kind === 'container' ? item.Config.Labels : item.Labels;
   for (const [key, value] of Object.entries(installation.labels)) assert.equal(labels[key], value);
  }
  const app = await inspect('container', installation.name + '-app');
  assert.ok(app.Config.Env.includes('TRUSTED_PROXY=caddy'));
  assert.deepEqual(Object.keys(app.NetworkSettings.Networks), [installation.name + '-ingress']);
  assert.deepEqual(app.HostConfig.PortBindings, {});
 }
 // An occupied HTTPS binding is refused while both installs keep serving.
 await f.select('https/one', a.origin);
 await f.cli(a, { env, success: false, extra: ['--bind-address', '127.0.0.1', '--http-port', '60584', '--https-port', '60583'] });
 assert.equal(await running(a), aId); assert.equal(await running(b), bId);
 await f.cli(a, { env, extra: ['--bind-address', '127.0.0.1', '--http-port', '60580', '--https-port', '60581'] });
 assert.equal(await running(b), bId);
 assert.equal((await inspect('container', b.name + '-caddy')).Id, caddyB);
 assert.equal((await health(a, aHost, 60585)).platform, 'container');
 assert.equal((await health(b, bHost, 60585)).platform, 'container');
 assert.deepEqual([...proxy.routed].sort(), [aHost, bHost]);
 t.diagnostic(JSON.stringify({flow:'https',firstTLSReady:(await health(a,aHost,60585)).platform==='container',secondTLSReady:(await health(b,bHost,60585)).platform==='container',otherAppPreserved:await running(b)===bId,otherIngressPreserved:(await inspect('container',b.name+'-caddy')).Id===caddyB,certificateVerification:true,sharedSniProxyRoutes:[...proxy.routed].sort()}));
});
