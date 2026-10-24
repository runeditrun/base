import { seedOperation } from './failure.mjs';
import { objectClass } from './config.mjs';
import { application, loaded, bundle } from './loader.mjs';
import { r2Call } from './r2.mjs';
import { store } from './r2-store.mjs';

export async function database(host, binding, method, args) {
  await host.active();
  if (!bundle.bindings.databases.includes(binding) || !['query', 'batch', 'exec'].includes(method)) throw new Error('Unknown D1 binding or method');
  const { ctx, env, state } = host, id = ctx.id.toString();
  const stub = binding === bundle.bindings.databases[0] ? application(env, ctx, id, state.runtime)
    : ctx.facets.get(`database:${binding}`, () => ({ class: loaded(env, ctx, id, state.runtime).getDurableObjectClass('DemoDatabase') }));
  return seedOperation(() => stub[method](...args));
}
export async function object(host, binding, id, method, args) {
  await host.active();
  const declared = bundle.bindings.objects.find(item => item.name === binding);
  if (!declared || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Unknown Durable Object binding or id');
  const state = host.state, name = `object:${binding}:${id}`;
  await host.ctx.storage.put(`facet:${name}`, true);
  if (host.state !== state || state.phase === 'ending') throw new Error('demo-ended');
  const stub = host.ctx.facets.get(name, () => ({ class: loaded(host.env, host.ctx, host.ctx.id.toString(), host.state.runtime).getDurableObjectClass(objectClass(binding)), id }));
  if (['constructor', 'then'].includes(method) || method.startsWith('_')) throw new Error('Invalid Durable Object method');
  return seedOperation(() => stub[method](...args));
}
export async function r2(host, binding, method, args) {
  await host.active();
  if (!bundle.bindings.buckets.includes(binding)) throw new Error('Unknown R2 binding');
  host.r2Store ??= store(host.ctx.storage);
  const operation = r2Call(host.r2Store, binding, method, args);
  host.r2Pending ??= new Set(); host.r2Pending.add(operation);
  try { return await operation; } finally { host.r2Pending.delete(operation); }
}
export async function eraseResources(host) {
  host.ctx.facets.delete('app');
  for (const binding of bundle.bindings.databases.slice(1)) host.ctx.facets.delete(`database:${binding}`);
  for (const key of (await host.ctx.storage.list({ prefix: 'facet:' })).keys()) host.ctx.facets.delete(key.slice(6));
  // R2 objects are rows of the visitor's own storage, erased with it.
  await Promise.allSettled(host.r2Pending ?? []);
  host.r2Store = undefined;
}
