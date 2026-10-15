import { bounded, category, report } from './diagnostics.mjs';
import { fingerprint } from './capacity.mjs';

// Kept by the visitor's Durable Object while the front returns short progress
// responses. A dropped browser request cannot abandon cleanup or hold a place
// until the demo's hour expires.
export async function finishStart(demo, options) {
  const { correlation, ends } = options, id = demo.ctx.id.toString();
  try {
    report(correlation, Date.now(), 'reservation', { heldId: await fingerprint(id) });
    const result = await bounded(demo.start(options), demo.startTimeout + 1000);
    if (!await bounded(demo.env.CAPACITY.get(demo.env.CAPACITY.idFromName('capacity')).extend(id, ends), 2000) || demo.stopped) throw new Error('start-reservation-expired');
    await demo.ctx.storage.put('startup', { phase: 'ready', ...result });
    await demo.ctx.storage.delete('startDeadline');
  } catch (error) {
    const failure = ['health-deadline', 'container-stopped', 'start-reservation-expired'].includes(error.message) ? error.message : category(error);
    demo.record('failed', { error: failure });
    try {
      const diagnostic = await bounded(demo.diagnostic(), 3000);
      await bounded(demo.env.CAPACITY.get(demo.env.CAPACITY.idFromName('diagnostics')).record(correlation, { ...diagnostic, failure }), 3000);
    } catch (capture) { report(correlation, demo.started, 'diagnostic', { error: category(capture) }); }
    await demo.ctx.storage.put('startup', { phase: 'failed' });
    try { await demo.end(); } catch (cleanup) { report(correlation, demo.started, 'cleanup', { error: category(cleanup) }); }
  }
}
