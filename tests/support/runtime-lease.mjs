// Serialize cases even when a consumer opts into node:test concurrency.
export function runtimeLease() {
  let tail = Promise.resolve();
  return async () => {
    const previous = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    let released = false;
    return () => { if (!released) { released = true; unlock(); } };
  };
}
