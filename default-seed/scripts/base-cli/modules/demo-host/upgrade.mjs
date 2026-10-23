import { demoInventory } from './remove.mjs';
import { removeBucket } from './native/deploy-r2.mjs';
import { DENY, admit, emit } from '../ai/native/names.mjs';

// Keep the Worker and custom domains throughout the transition. Container apps
// must go before deleting their backing class; Wrangler then applies the class
// migration atomically with the native code. A failed upload can be rerun.
export async function upgradeDemo({ api, plan, report = () => {} }) {
  const found = await demoInventory(api, plan);
  const classes = found.namespaces.map(row => row.class);
  const unknown = classes.filter(name => !['DemoContainer', 'NativeDemo', 'DemoCapacity'].includes(name));
  if (unknown.length) throw new Error('demo-upgrade-unknown-class');
  const service = found.worker ? await api.request(`/workers/services/${plan.worker}`) : null;
  const tag = service?.default_environment?.script?.migration_tag;
  if (found.worker && classes.length && !tag) throw new Error('demo-upgrade-missing-migration-tag');
  const migration = { tag: 'native-v2' };
  const added = ['NativeDemo', 'DemoCapacity'].filter(name => !classes.includes(name));
  if (added.length) migration.new_sqlite_classes = added;
  if (classes.includes('DemoContainer')) migration.deleted_classes = ['DemoContainer'];
  if (tag === migration.tag && (added.length || migration.deleted_classes)) throw new Error('demo-upgrade-inconsistent-migration');
  for (const app of found.apps) await api.request(`/containers/applications/${app.id}`, { method: 'DELETE' });
  if (found.apps.length) {
    const remaining = await api.request('/containers/applications');
    if (remaining.some(row => found.apps.some(app => app.id === row.id))) throw new Error('demo-upgrade-container-remove-incomplete');
  }
  // The retired shared R2 bucket goes while its binding still proves ownership;
  // the new code binds no bucket. A rerun after a partial removal resumes.
  if (found.bucket) {
    await removeBucket(api, found.bucket);
    report(`Removed the retired shared demo R2 bucket ${found.bucket.name}; R2 now lives in each visitor's storage.`);
  }
  if (classes.includes('DemoContainer')) {
    // The API checks the currently deployed bindings before class deletion.
    // Detach the retired binding first; inherit every other value by name,
    // including secrets, and retain the ownership annotation for a rerun.
    const body = new FormData(), kept = admit(DENY, found.settings.bindings.filter(binding => !(binding.type === 'durable_object_namespace' && binding.class_name === 'DemoContainer')));
    body.set('settings', new Blob([JSON.stringify({
      annotations: { 'workers/message': plan.record },
      bindings: emit(DENY, kept.map(binding => ({ name: binding.name, type: 'inherit' }))),
    })], { type: 'application/json' }));
    await api.request(`/workers/scripts/${plan.worker}/settings`, { method: 'PATCH', body });
  }
  // Wrangler validates the full declared history locally, even though only
  // steps after the deployed tag are sent. Describe the existing classes in
  // that historical step so a deletion resolves without shipping old code.
  if (tag === migration.tag) return [{ tag, new_sqlite_classes: classes }];
  return tag ? [{ tag, new_sqlite_classes: classes }, migration] : [migration];
}
