import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const proxied = env => Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
const loopback = ['127.0.0.1', 'localhost', '::1'];

// Node reads these at startup, before any fetch or imported application code.
// Lowercase has precedence in Node; preserve both lists when adding loopback.
export function proxyEnvironment(env = process.env) {
 if (!proxied(env)) return env;
 const bypass = [...new Set([env.no_proxy, env.NO_PROXY].filter(Boolean).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean).concat(loopback))].join(',');
 return { ...env, NODE_USE_ENV_PROXY: '1', NO_PROXY: bypass, no_proxy: bypass };
}

// NODE_USE_ENV_PROXY is unavailable on the project's 22.20.0 pin. Do not
// silently attempt direct downloads on that runtime. No pin is changed here.
export function requireDownloadProxySupport() {
 if (!proxied(process.env)) return;
 const [major, minor] = process.versions.node.split('.').map(Number);
 if (!((major === 22 && minor >= 21) || major >= 24)) {
  throw Error('Proxy downloads require Node 22.21.0 or Node 24 or later; this Node does not support NODE_USE_ENV_PROXY. Install a supported Node runtime before retrying, or preinstall the project tools.');
 }
 if (process.env.NODE_USE_ENV_PROXY !== '1') throw Error('Proxy downloads must start through the rer command with NODE_USE_ENV_PROXY=1.');
}

export async function startWithEnvironmentProxy(argv) {
 const env = proxyEnvironment();
 if (env === process.env || ['NODE_USE_ENV_PROXY', 'NO_PROXY', 'no_proxy'].every(name => env[name] === process.env[name])) return;
 const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...argv], { env, stdio: 'inherit' });
 const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
 for (const [signal, handler] of handlers) process.on(signal, handler);
 try {
  return await new Promise((resolve, reject) => {
   child.once('error', reject);
   child.once('exit', (code, signal) => resolve({ exitCode: code ?? 128 + (constants.signals[signal] ?? 0) }));
  });
 } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}
