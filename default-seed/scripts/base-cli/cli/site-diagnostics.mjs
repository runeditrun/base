import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

// Vite and config plugins can write directly, before a build rejects. Redact
// at this child process's output boundary, including paths split across writes.
export function redactSiteText(text) {
 return text.replaceAll(homedir(), '~')
  .replace(/\/(?:Users|home)\/[^/\s:)'"<>]+/g, '~')
  .replace(/[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\r\n:)'"<>]+/gi, '~');
}

export function redactSiteOutput() {
 for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream), decoder = new StringDecoder('utf8');
  let pending = '';
  stream.write = (chunk, encoding, callback) => {
   if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
   pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
   const end = pending.lastIndexOf('\n') + 1;
   const ready = pending.slice(0, end); pending = pending.slice(end);
   if (ready) return write(redactSiteText(ready), encoding, callback);
   callback?.(); return true;
  };
  process.on('exit', () => { pending += decoder.end(); if (pending) write(redactSiteText(pending)); });
 }
}

export function siteBuildDiagnostic(error) {
 const message = String(error?.message ?? error);
 const plugin = error?.plugin && !message.includes(error.plugin) ? `[plugin ${error.plugin}]\n` : '';
 const file = error?.loc?.file ?? error?.id;
 const location = file ? `${file}${error.loc?.line ? `:${error.loc.line}${error.loc.column !== undefined ? `:${error.loc.column}` : ''}` : ''}` : '';
 const frame = error?.frame && !message.includes(error.frame) ? error.frame : '';
 return [plugin + message, location && !message.includes(location) ? location : '', frame].filter(Boolean).join('\n');
}
