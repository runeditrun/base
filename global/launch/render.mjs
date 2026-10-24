import { qualifyHints } from './hints.mjs';

// What `rer dev` prints while it launches: one line per step, one honest line
// after every 5 seconds of quiet, a `progress` event
// for each with --json, then the dispatcher's ready lines and, last, one line
// a person reads first: the app's name, its address and how to open it.
const elapsed = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const quiet = 5000, advise = 30000;

// `keyless`: stdout is not a terminal (an agent, a pipe, CI, a log) or the
// front door started the launch. The ready lines then never carry the dev-key
// link; `openHint` (rer open) opens the app signed in on this computer.
// `open`, when given, opens the browser at ready and resolves { opened }.
// `reattach` is the command that picks a stopped wait up again.
export function printer({ json, stopHint, keyless = false, name, openHint, open, reattach = 'rer dev' }) {
 const started = Date.now();
 let current = 'preparing', last = Date.now(), stepStarted = Date.now(), advised = false;
 const event = (name, fields) => process.stdout.write(JSON.stringify({ version: 1, verb: 'dev', event: name, ...fields }) + '\n');
 const line = text => process.stderr.write(`rer dev: ${text}\n`);
 const progress = (phase, message) => {
  last = Date.now();
  if (json) event('progress', { phase, message, elapsedSeconds: Math.round((last - started) / 1000) });
  else line(message);
 };
 return {
  phase({ phase, message }) { if (phase !== 'note') { current = message; stepStarted = Date.now(); } progress(phase, message); },
  attaching(startedAt) { progress('attach', `attaching to the launch already preparing this checkout (started ${elapsed(Date.now() - startedAt)} ago)`); },
  activity() { last = Date.now(); },
  heartbeat() {
   if (Date.now() - last < quiet) return;
   const long = !advised && Date.now() - stepStarted >= advise;
   if (long) advised = true;
   progress('waiting', `still ${current} (${elapsed(Date.now() - stepStarted)})${long ? `. A first launch can take a few minutes; if this command is stopped, run ${reattach} again to reattach.` : ''}`);
  },
  // The dispatcher's ready event, as the ready lines and the closing line.
  async ready(ready, { log, pid }) {
   const opened = open && ready.openUrl ? await open(ready) : undefined;
   if (keyless) { const { openUrl, ...rest } = ready; ready = rest; }
   if (json) { event('server', { pid, log }); process.stdout.write(JSON.stringify({ ...ready, ...(opened ? { opened: opened.opened } : {}) }) + '\n'); return; }
   const out = [`RER_READY ${ready.url}`];
   if (ready.signedInAs) out.push(`RER_SIGNED_IN ${ready.signedInAs}`);
   if (ready.openUrl) out.push(`RER_OPEN ${ready.openUrl}`, 'Open that link on this computer. Its fragment holds this checkout\'s dev key, which the page keeps only as a cookie; never share the link.');
   // A seed with a run site: its static homepage, /run and docs, served locally.
   if (ready.siteUrl) out.push(`RER_SITE ${ready.siteUrl}`);
   out.push(`The server keeps running in the background${pid ? ` (PID ${pid})` : ''}. Stop it with: ${stopHint}`);
   if (log) out.push(`Server log (private): ${log}`);
   out.push(closingLine({ name, url: ready.url, signedInAs: ready.signedInAs, linked: Boolean(ready.openUrl), openHint, opened }));
   process.stdout.write(out.join('\n') + '\n');
  },
  failure(failure) {
   if (json) {
    if (failure.event) process.stdout.write(JSON.stringify(qualifyHints(failure.event, stopHint)) + '\n');
    else event('error', { code: 'launch_refused', message: qualifyHints(failure.message, stopHint), exitCode: failure.exitCode });
    event('result', { ok: false, exitCode: failure.exitCode });
   } else process.stderr.write(qualifyHints(failure.message, stopHint) + '\n');
  },
 };
}

// The one line a person reads first. Its address never carries the dev key.
// `foreground`: this terminal is serving the app, so rer open runs in another
// one and Ctrl-C here stops it.
export function closingLine({ name = 'The app', url, signedInAs, linked, openHint, opened, foreground = false }) {
 const who = signedInAs ? ` as ${signedInAs}` : '', stop = foreground ? ' Ctrl-C here stops it.' : '', elsewhere = foreground ? ' in another terminal' : '';
 if (opened?.opened) return `${name} is running at ${url} and opened in your browser, signed in${who}. If no window appeared, run${elsewhere}: ${openHint}.${stop}`;
 if (!openHint || signedInAs === undefined && !linked) return `${name} is running. Open it: ${url}${stop}`;
 return `${name} is running. Open it: ${url}${linked ? ` (signed in${who}: use the RER_OPEN link above, or run${elsewhere} ${openHint})` : ` (to open it signed in${who} on this computer, run${elsewhere}: ${openHint})`}.${stop}`;
}
