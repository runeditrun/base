import { StringDecoder } from 'node:string_decoder';

/** Keep a possible credential prefix across writes; neither chunk boundaries nor EOF release it. */
export function commandMask(values, output) {
 const secrets = [...new Set(values.filter(value => typeof value === 'string' && value).flatMap(value =>
  [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]))].sort((a, b) => b.length - a.length);
 const decoder = new StringDecoder('utf8');
 let pending = '';
 function replace(text) { for (const secret of secrets) text = text.split(secret).join('[credential]'); return text; }
 function write(chunk) {
  pending = replace(pending + decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  let held = 0;
  for (const secret of secrets) for (let count = Math.min(secret.length - 1, pending.length); count > held; count--)
   if (pending.endsWith(secret.slice(0, count))) { held = count; break; }
  const ready = pending.slice(0, pending.length - held);
  pending = pending.slice(pending.length - held);
  if (ready) output.write(ready);
 }
 return { write, end() { pending = replace(pending + decoder.end()); if (pending) output.write('[credential]'); pending = ''; },
  text: replace };
}
