// Cloudflare can exhaust its prepared instances before reaching max_instances.
// Keep this visitor's reservation while that pool grows. Only the provider's
// explicit no-instance response permits another placement attempt; boot, health
// and claim failures still terminate the start.
export async function placeContainer(demo, options, deadline) {
  let attempt = 0;
  while (Date.now() < deadline && !demo.cancelled) {
    demo.stopped = false;
    demo.stopReason = undefined;
    demo.container.start(options);
    demo.watch();
    await demo.ctx.storage.setAlarm(deadline);
    try {
      await demo.healthy(deadline);
      return;
    } catch (error) {
      if (demo.cancelled || demo.stopReason !== 'placement-unavailable') throw error;
      demo.record('placement', { attempt: ++attempt, outcome: 'waiting' });
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
    }
  }
  throw new Error(demo.cancelled ? 'container-stopped' : 'placement-unavailable');
}
