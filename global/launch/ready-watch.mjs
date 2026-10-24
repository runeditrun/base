// A terminal launch hands the app to the checkout's own dispatcher in this
// process, and the dispatcher prints its own ready lines. watchReady reads
// what it writes to stdout: when stdout is not a terminal it drops the dev-key
// link (the RER_OPEN line, the sentence after it, a JSON event's openUrl), and
// after the ready lines it adds the closing line, opening the browser first
// when asked. Every other byte passes through unchanged.
import { closingLine } from './render.mjs';

const keySentence = 'Open that link on this computer.';
// A line that may carry the key or the ready facts is read whole: its start is
// held until its end arrives.
const heldStarts = ['RER_', '{', keySentence];
const held = text => heldStarts.some(start => start.startsWith(text) || text.startsWith(start));

export function watchReady({ keyless, json, name, openHint, opener, foreground = true }) {
 const write = process.stdout.write.bind(process.stdout);
 let ready, scheduled = false, done = false, pending = '';
 const finish = async () => {
  done = true;
  const opened = opener && ready.openUrl ? await opener(ready) : undefined;
  if (!json) write(closingLine({ name, url: ready.url, signedInAs: ready.signedInAs, linked: !keyless && Boolean(ready.openUrl), openHint, opened, foreground }) + '\n');
 };
 const read = text => {
  if (json) {
   let event;
   try { event = JSON.parse(text); } catch { return text; }
   if (event?.event !== 'ready' || typeof event.url !== 'string') return text;
   ready ??= event;
   if (!keyless || event.openUrl === undefined) return text;
   const { openUrl, ...rest } = event;
   return JSON.stringify(rest);
  }
  const [tag, ...value] = text.split(' ');
  if (tag === 'RER_READY' && !ready) ready = { url: value.join(' ') };
  else if (ready && !done && tag === 'RER_SIGNED_IN') ready.signedInAs = value.join(' ');
  else if (ready && !done && tag === 'RER_OPEN') ready.openUrl = value.join(' ');
  if (keyless && (tag === 'RER_OPEN' || text.startsWith(keySentence))) return undefined;
  return text;
 };
 process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) return write(chunk, ...rest);
  const lines = (pending + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))).split('\n');
  pending = lines.pop();
  let kept = lines.map(read).filter(line => line !== undefined).map(line => line + '\n').join('');
  if (pending && !held(pending)) { kept += pending; pending = ''; }
  // The dispatcher writes its ready lines in one turn: close after them.
  if (ready && !scheduled) { scheduled = true; setImmediate(() => { finish().catch(() => {}); }); }
  return kept ? write(kept, ...rest) : (typeof rest.at(-1) === 'function' && rest.at(-1)(), true);
 };
 // A held line the dispatcher never ended still prints, unless it holds the key.
 process.once('beforeExit', () => { const last = pending && read(pending); pending = ''; if (last) write(last); });
}
