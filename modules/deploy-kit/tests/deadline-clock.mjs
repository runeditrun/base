/** The readiness clock and its deadline signals advance together, on demand. */
export function deadlineClock(totalMs = 50) {
  let now = 0;
  const deadlines = new Map();
  function advance(ms, dispatch = true) {
    now += ms;
    if (dispatch) for (const [controller, at] of deadlines) if (at <= now) {
      deadlines.delete(controller);
      controller.abort(new DOMException('Readiness deadline expired','TimeoutError'));
    }
  }
  return {
    advance,
    readiness: {totalMs,clock:() => now,sleep:async ms => advance(ms),timeout(ms) {
      const controller = new AbortController();
      deadlines.set(controller,now + ms);
      return controller.signal;
    }},
  };
}
