// Only fixed categories and numeric metadata enter provider logs. No request,
// container response body, cookie, environment value or raw error is retained.
export function category(error) {
  const message = String(error?.message ?? '');
  if (message === 'placement-unavailable' || /there is no container instance that can be provided to this Durable Object, try again later/i.test(message)) return 'placement-unavailable';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'probe-timeout';
  if (/connection refused|not listening|port.*not.*ready/i.test(message)) return 'port-not-ready';
  if (/container.*not.*running|container.*stopped/i.test(message)) return 'container-stopped';
  if (/disconnect|connection reset|network connection lost/i.test(message)) return 'connection-lost';
  return error instanceof TypeError ? 'transport-type-error' : 'platform-error';
}
export function report(correlation, started, event, detail = {}) {
  console.log(JSON.stringify({ event: `demo_${event}`, correlation, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...detail }));
}
export async function boundedFetch(port, url, init, milliseconds) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DOMException('probe deadline', 'TimeoutError')); }, milliseconds); });
  try {
    const request = port.fetch(url, { ...init, signal: controller.signal }).then(response => {
      if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
      return response;
    });
    return await Promise.race([request, timeout]);
  }
  finally { clearTimeout(timer); }
}

export async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException('operation deadline', 'TimeoutError')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
