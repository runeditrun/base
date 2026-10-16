// Only fixed categories and numeric metadata enter provider logs. No request,
// isolate response body, cookie, environment value or raw error is retained.
export function category(error) {
  const message = String(error?.message ?? '');
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'probe-timeout';
  if (/disconnect|connection reset|network connection lost/i.test(message)) return 'connection-lost';
  return error instanceof TypeError ? 'transport-type-error' : 'platform-error';
}
export function report(correlation, started, event, detail = {}) {
  console.log(JSON.stringify({ event: `demo_${event}`, correlation, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...detail }));
}
export async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException('operation deadline', 'TimeoutError')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
