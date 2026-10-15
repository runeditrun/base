import { watch } from 'node:fs';

// Miniflare computes its asset manifest (and ETags) at setOptions, not per
// request. Refresh it when built assets change; keep the same durable state.
// Workers/modules remain fixed production output: no source build runs here.
export function watchProductionAssets(runtime, options, convert, onError) {
 const directories = [...new Set((options.workers ?? [options]).map(worker => worker.assets?.directory).filter(Boolean))];
 const watchers = [];
 let timer, pending = Promise.resolve(), closed = false;
 const refresh = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
   pending = pending.then(async () => { if (!closed) await runtime.setOptions(convert(options)); }).catch(error => { if (!closed) onError(error); });
  }, 50);
 };
 try {
  for (const directory of directories) {
   const watcher = watch(directory,{recursive:true},refresh);
   watcher.on('error',onError); watchers.push(watcher);
  }
 } catch (error) { for (const watcher of watchers) watcher.close(); throw error; }
 return async () => {closed=true;clearTimeout(timer);for(const watcher of watchers)watcher.close();await pending;};
}
