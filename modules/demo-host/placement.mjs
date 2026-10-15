import { bounded } from './diagnostics.mjs';

// Cloudflare keeps a small prepared pool per application (7 instances measured
// on fresh hosts) and prepares more only on demand: a start beyond the pool
// waits while Cloudflare places a new instance (16-37 s measured), then boots
// normally. Keep this visitor's reservation through that wait. Only the
// provider's explicit no-instance response permits another placement attempt,
// and it renews the boot budget up to placementTimeout from the start; boot,
// health and claim failures still terminate the start. Returns the deadline the
// placed container must become healthy and claimed by.
export async function placeContainer(demo, options, deadline) {
  const limit = demo.started + demo.placementTimeout, capacity = demo.env.CAPACITY.get(demo.env.CAPACITY.idFromName('capacity'));
  let attempt = 0;
  while (Date.now() < deadline && !demo.cancelled) {
    demo.stopped = false;
    demo.stopReason = undefined;
    demo.container.start(options);
    demo.watch();
    await demo.ctx.storage.setAlarm(deadline);
    try {
      await demo.healthy(deadline);
      return deadline;
    } catch (error) {
      if (demo.cancelled || demo.stopReason !== 'placement-unavailable') throw error;
      demo.record('placement', { attempt: ++attempt, outcome: 'waiting' });
      const renewed = Math.min(limit, Date.now() + demo.startTimeout);
      if (renewed > deadline) {
        // The reservation outlives the renewed budget, or the place is no longer this visitor's.
        if (!await bounded(capacity.extend(demo.ctx.id.toString(), renewed + 15_000), 2000)) throw new Error('start-reservation-expired');
        deadline = renewed;
        await demo.ctx.storage.put('startDeadline', deadline);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
    }
  }
  throw new Error(demo.cancelled ? 'container-stopped' : 'placement-unavailable');
}
