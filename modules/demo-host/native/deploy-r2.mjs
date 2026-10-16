import { r2ObjectPages, r2ObjectPath } from '../../deploy-kit/r2-objects.mjs';

// rer 0.2.30-0.2.33 kept every visitor's R2 objects in one demo bucket. Demo
// R2 now lives in each visitor's storage; an upgrade or removal empties and
// deletes that bucket when the served Worker still proves it owns it.
const demoBucketName = worker => `${worker.replace(/-+/g, '-').slice(0, 48)}-objects`;
const missing = async (api, name) => {
  try { return await api.request(`/r2/buckets/${name}`); }
  catch (error) { if (error.status === 404) return null; throw error; }
};
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
