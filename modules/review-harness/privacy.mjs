// Keep credentials out of diagnostics, including browser call-log URLs.
export function redact(text, secrets = []) {
  let value = String(text);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) value = value.replaceAll(form, '[redacted]');
  }
  return value.replace(/(\btoken=)[^\s&;"'<>#]*/gi, '$1[redacted]');
}

export function safeUrl(value, secrets = [], pathOnly = false) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (/token/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    url.username = ''; url.password = '';
    return redact(pathOnly ? url.pathname + url.search : url.href, secrets);
  } catch { return redact(value, secrets); }
}

export function sanitize(value, secrets = []) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, secrets)]));
  return value;
}
