// Only diagnostics constructed at this boundary can reach the public runner.
// Never approve a server message, response body, URL or mutable Error property.
const diagnostics = new WeakMap();
export const transferDiagnostic = error => diagnostics.get(error);
const jobPattern = /^[a-zA-Z0-9-]{1,100}$/;
const stages = new Set(['create', 'status', 'advance', 'download', 'parts', 'finalize', 'abort']);

export function transferClient({ endpoint, origin, cookie }) {
  const secrets = [cookie, cookie.slice(cookie.indexOf('=') + 1)].filter(Boolean);
  const publicValue = value => !secrets.some(secret => value.includes(secret));
  const jobId = value => typeof value === 'string' && jobPattern.test(value) && !value.includes('\n') && publicValue(value) ? value : undefined;
  const responses = new WeakMap();
  function failure(path, status, body) {
    const [collection, id, action] = path.split('/');
    const operation = collection === 'exports' ? 'export' : 'import';
    const step = stages.has(action) ? action : id ? 'status' : 'create';
    const details = [];
    if (jobId(id)) details.push('job ' + id);
    if (Number.isInteger(status) && status >= 100 && status <= 599) details.push('HTTP ' + status);
    const raw = body?.code ?? body?.error?.code ?? body?.error;
    // Portability codes may append table, key or row details after a colon.
    // Retain only the bounded machine identifier, never those private details.
    const code = typeof raw === 'string' && publicValue(raw) ? raw.split(':', 1)[0] : undefined;
    if (code && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) && !code.includes('\n') && publicValue(code)) details.push('code ' + code);
    else if (Number.isSafeInteger(raw) && raw >= 0 && publicValue(String(raw))) details.push('code ' + raw);
    const message = `Hosted ${operation} ${step} failed${details.length ? ' (' + details.join('; ') + ')' : ''}.`;
    const error = new Error(message);
    diagnostics.set(error, message);
    return error;
  }
  async function request(path, method = 'GET', body) {
    let response;
    try {
      response = await fetch(endpoint + '/' + path, { method, redirect: 'error',
        headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw failure(path); }
    if (!response.ok) throw failure(path, response.status, await errorBody(response));
    return response;
  }
  return {
    request,
    async get(...args) {
      const response = await request(...args);
      let body;
      try { body = await response.json(); } catch { throw failure(args[0], response.status); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(args[0], response.status);
      responses.set(body, response.status);
      return body;
    },
    jobId(value, collection) {
      if (!jobId(value)) throw failure(collection);
      return value;
    },
    failedJob(path, body) { return failure(path, responses.get(body), body); },
  };
}

// Error responses can be arbitrary provider HTML or huge private diagnostics.
// Read a bounded JSON envelope solely to recover its machine code.
async function errorBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    let size = 0; const chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) return;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return; }
  finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
