import { workerSettings } from '../../deploy-kit/owner.mjs';
import { servedVersion } from '../../deploy-kit/site.mjs';
import { r2ObjectPages, r2ObjectPath } from '../../deploy-kit/r2-objects.mjs';

export const demoBucketName = worker => `${worker.replace(/-+/g, '-').slice(0, 48)}-objects`;
const missing = async (api, name) => {
  try { return await api.request(`/r2/buckets/${name}`); }
  catch (error) { if (error.status === 404) return null; throw error; }
};
export async function prepareBucket(api, plan, pending) {
  const name = demoBucketName(plan.worker), bucket = await missing(api, name);
  if (bucket) {
    const settings = await workerSettings(api, plan.worker), version = settings && await servedVersion(api, plan.worker);
    if (!settings && pending?.record === plan.record && pending.bucket?.name === name && pending.bucket.creation_date === bucket.creation_date) return bucket;
    if (!version?.current || version.annotation !== plan.record || !ownsBucket(settings, bucket)) throw new Error(`Demo R2 bucket ownership is unproven: ${name}`);
    return bucket;
  }
  return api.request('/r2/buckets', { method: 'POST', body: { name } });
}
function ownsBucket(settings, bucket) {
  return settings?.bindings?.some(item => item.type === 'r2_bucket' && item.name === 'NATIVE_BUCKET' && item.bucket_name === bucket.name)
    && settings.bindings.some(item => item.name === 'NATIVE_BUCKET_CREATED' && item.text === bucket.creation_date);
}
export async function ownedBucket(api, plan, settings) {
  const binding = settings?.bindings?.find(item => item.name === 'NATIVE_BUCKET' && item.type === 'r2_bucket');
  if (!binding) return null;
  if (binding.bucket_name !== demoBucketName(plan.worker)) throw new Error('demo-r2-name-collision');
  const bucket = await missing(api, binding.bucket_name);
  if (bucket && !ownsBucket(settings, bucket)) throw new Error('demo-r2-replaced');
  return bucket;
}
export async function removeBucket(api, bucket) {
  const check = async () => {
    const current = await missing(api, bucket.name);
    if (!current || current.creation_date !== bucket.creation_date) throw new Error('demo-r2-replaced');
  };
  for await (const page of r2ObjectPages(api, bucket.name)) for (const { key } of page) {
    await check(); await api.request(r2ObjectPath(bucket.name, key), { method: 'DELETE' });
  }
  await check(); await api.request(`/r2/buckets/${bucket.name}`, { method: 'DELETE' });
  if (await missing(api, bucket.name)) throw new Error('demo-r2-remove-incomplete');
}
