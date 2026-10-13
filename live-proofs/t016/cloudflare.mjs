import { jsonRequest, request } from '../../scripts/qualification/http.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';
import { digest } from '../../scripts/qualification/operations.mjs';
import { compareModuleBytes } from './artifact.mjs';

export function cloudflare(env) {
  insist(/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') && env.CLOUDFLARE_API_TOKEN, 'invalid-cloudflare-input');
  return async (path, body) => {
    const result = await jsonRequest(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    insist(result.success === true, 'cloudflare-readback-failed'); return result.result;
  };
}
export async function selectTarget(env, prefix) {
  const api = cloudflare(env);
  insist(/^[a-z][a-z0-9-]{2,39}$/.test(prefix), 'invalid-target-prefix');
  // Probe this exact script instead of relying on a possibly paginated list.
  const [subdomain, script] = await Promise.all([api('workers/subdomain'),
    request(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${prefix}`, {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    })]);
  insist(/^[a-z0-9][a-z0-9-]*$/.test(subdomain.subdomain ?? ''), 'workers-subdomain-unconfigured');
  insist(script.status === 404, 'target-not-confirmed-absent');
  return `https://${prefix}.${subdomain.subdomain}.workers.dev`;
}
export async function deploymentIdentity(env, { output, artifact, stage }) {
  const versions = [...output.matchAll(/Current Version ID:\s*([a-f0-9-]{36})/gi)].map(x => x[1]);
  insist(versions.length === 1, 'upload-version-unobserved');
  const versionId = versions[0];
  const result = await cloudflare(env)(`workers/scripts/${env.H2H_RESOURCE_PREFIX}/deployments`);
  const deployment = result.deployments?.[0];
  insist(deployment?.id && deployment.versions?.length === 1 && deployment.versions[0].version_id === versionId &&
    deployment.versions[0].percentage === 100, 'deployment-readback-failed');
  const body = await request(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${env.H2H_RESOURCE_PREFIX}`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }, 64 * 1024 * 1024);
  insist(body.status === 200 && /multipart\/form-data/.test(body.headers.get('content-type') ?? ''), 'serving-modules-unavailable');
  const form = await new Response(body.bytes, { headers: { 'content-type': body.headers.get('content-type') } }).formData();
  const modules = new Map();
  for (const [key, value] of form) {
    const name = key.replace(/^\.\//, '');
    insist(!modules.has(name) && typeof value.arrayBuffer === 'function', 'invalid-serving-module');
    modules.set(name, Buffer.from(await value.arrayBuffer()));
  }
  compareModuleBytes(artifact.files, modules);
  const assets = artifact.files.filter(file => file.path.startsWith('dist/client/'));
  for (const file of assets) {
    const served = await request(env.H2H_PUBLIC_ORIGIN + '/' + file.path.slice('dist/client/'.length), {}, 64 * 1024 * 1024);
    insist(served.status === 200 && digest(served.bytes) === file.sha256, 'serving-asset-bytes-mismatch');
  }
  const after = await cloudflare(env)(`workers/scripts/${env.H2H_RESOURCE_PREFIX}/deployments`);
  insist(after.deployments?.[0]?.id === deployment.id, 'serving-version-raced');
  return { stage, origin: env.H2H_PUBLIC_ORIGIN, worker: env.H2H_RESOURCE_PREFIX, deploymentId: deployment.id, versionId,
    sourceSha: artifact.sourceSha, artifactSha256: artifact.artifactSha256,
    workerSha256: artifact.files.find(x => x.path === 'dist/server/index.js').sha256, assetsSha256: digest(assets) };
}
export async function r2DisabledReadback(env) {
  cloudflare(env); // Validate account and credential shape before URL construction.
  const result = await request(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  const body = JSON.parse(result.text);
  insist([400, 403].includes(result.status) && body.success === false && Array.isArray(body.errors) &&
    body.errors.some(error => typeof error.message === 'string' && /(?:enable R2|R2.*(?:not enabled|disabled))/i.test(error.message)), 'r2-disabled-error-not-observed');
  const error = body.errors.find(error => /(?:enable R2|R2.*(?:not enabled|disabled))/i.test(error.message));
  insist(Number.isInteger(error.code), 'r2-error-code-missing');
  return { status: result.status, code: error.code };
}
export function databaseReader(config, env) {
  const id = config.d1_databases?.find(x => x.binding === 'DB')?.database_id;
  insist(/^[a-f0-9-]{36}$/i.test(id ?? '') && config.account_id === env.CLOUDFLARE_ACCOUNT_ID, 'invalid-database-target');
  return async (sql, params = []) => {
    const result = await cloudflare(env)(`d1/database/${id}/query`, { sql, params });
    insist(Array.isArray(result) && result.length === 1 && result[0].success === true && Array.isArray(result[0].results), 'database-readback-failed');
    return result[0].results;
  };
}
export function verifyMigrationTransition(before, after, rollback = false) {
  for (const rows of [before, after]) insist(Array.isArray(rows) && rows.length > 0 &&
    rows.every(row => typeof row.name === 'string' && row.name.endsWith('.sql')) &&
    new Set(rows.map(row => row.name)).size === rows.length, 'invalid-migration-readback');
  insist(before.every(row => after.some(next => next.name === row.name)) &&
    (!rollback || JSON.stringify(before) === JSON.stringify(after)), 'migration-history-changed');
}
