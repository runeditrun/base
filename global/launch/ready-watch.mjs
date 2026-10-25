// Observe the dispatcher's output, including inherited output from a Node-pin
// re-exec. Hold whole lines so no credential prefix escapes into a pipe.
import { StringDecoder } from 'node:string_decoder';
import { closingLine } from './render.mjs';
import { openCheckout, qualifyHints } from './hints.mjs';

const keySentence = 'Open that link on this computer.';
// A quoted path is far shorter; past this a record is shown as it stands.
const heldLimit = 65536;
const parses = text => { try { JSON.parse(text); return true; } catch { return false; } };

export function watchReady({ keyless, json, name, openHint, stopHint, opener, foreground = true, piped = false, onOutput = () => {}, onReady = () => {} }) {
 const write = process.stdout.write.bind(process.stdout);
 let ready, scheduled, finished;
 const finish = () => finished ??= (async () => {
  if (!ready) return;
  onReady();
  const opened = opener ? await opener(ready) : undefined;
  if (!json) write(closingLine({ name, url: ready.url, signedInAs: ready.signedInAs, linked: !keyless && Boolean(ready.openUrl), openHint, opened, foreground }) + '\n');
 })();
 const read = text => {
  if (json) {
   let event;
   try { event = JSON.parse(text); } catch { return qualifyHints(text, stopHint); }
   const shown = qualifyHints(event, stopHint);
   if (event?.event !== 'ready' || typeof event.url !== 'string') return JSON.stringify(shown);
   ready ??= event;
   if (!keyless || event.openUrl === undefined) return JSON.stringify(shown);
   const { openUrl, ...rest } = shown;
   return JSON.stringify(rest);
  }
  const [tag, ...value] = text.split(' ');
  if (tag === 'RER_READY' && !ready) ready = { url: value.join(' ') };
  else if (ready && !finished && tag === 'RER_SIGNED_IN') ready.signedInAs = value.join(' ');
  else if (ready && !finished && tag === 'RER_OPEN') ready.openUrl = value.join(' ');
  if (keyless && (tag === 'RER_OPEN' || text.startsWith(keySentence))) return undefined;
  return qualifyHints(text, stopHint);
 };
 // A quoted checkout can hold newlines. Its lines stay one record until the
 // quote closes, so no line inside it is read as a command of its own.
 const continues = text => text.length <= heldLimit && openCheckout(text, stopHint) && !parses(text);
 const stream = output => {
  const decoder = new StringDecoder('utf8');
  let pending = '', held;
  const flush = chunk => {
   onOutput();
   const lines = (pending + chunk).split('\n'); pending = lines.pop();
   const records = [];
   for (const line of lines) {
    const text = held === undefined ? line : `${held}\n${line}`;
    held = continues(text) ? text : undefined;
    if (held === undefined) records.push(text);
   }
   let kept = records.map(read).filter(line => line !== undefined).map(line => line + '\n').join('');
   if (ready && !scheduled) { scheduled = true; setImmediate(() => { finish().catch(() => {}); }); }
   return kept ? output(kept) : true;
  };
  return { write: chunk => flush(typeof chunk === 'string' ? chunk : decoder.write(chunk)), end: () => { const last = read((held === undefined ? '' : `${held}\n`) + pending + decoder.end()); held = undefined; pending = ''; if (last) output(last); } };
 };
 const stdout = stream(write), stderr = stream(process.stderr.write.bind(process.stderr));
 if (!piped) {
  process.stdout.write = (chunk, ...rest) => {
   const result = stdout.write(chunk); if (typeof rest.at(-1) === 'function') rest.at(-1)(); return result;
  };
  process.once('beforeExit', () => stdout.end());
 }
 return { stdout: stdout.write, stderr: stderr.write, async close() { stdout.end(); stderr.end(); await finish(); } };
}
