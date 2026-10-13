import { insist } from './operations.mjs';
export function hostedOrigin(value) {
  const url = new URL(value);
  insist(url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' &&
    !url.search && !url.hash && !/^(localhost|127\.|0\.|\[|.*\.local$)/i.test(url.hostname), 'invalid-hosted-origin');
  return url.origin;
}
export async function request(url, options = {}, maxBytes = 4 * 1024 * 1024) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const reader = response.body?.getReader();
  let size = 0; const chunks = [];
  if (reader) for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new Error('response-too-large'); }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') };
}
export async function jsonRequest(url, options = {}, expected = 200) {
  const result = await request(url, options);
  insist(result.status === expected, 'http-status-failed');
  return JSON.parse(result.text);
}
export async function healthAndWidget(origin, descriptor, widgetPath) {
  for (const path of [descriptor.health?.path, widgetPath]) insist(typeof path === 'string' && /^\/(?!\/)[^?#]*$/.test(path), 'invalid-probe-path');
  const health = await jsonRequest(origin + descriptor.health.path);
  insist(health?.status === 'ok', 'health-body-failed');
  const widget = await request(origin + widgetPath);
  insist(widget.status === 200 && widget.text.length > 0 && /javascript/.test(widget.headers.get('content-type') ?? ''), 'widget-failed');
  return { health, widget };
}
