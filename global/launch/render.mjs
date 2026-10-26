// What `rer dev` prints while it launches: a progress line at least every 30
// seconds (a `progress` event with --json), then the dispatcher's ready lines.
import { readySummary } from '../../cli/ready-summary.mjs';
import { launchSummary } from '../../cli/run-transfers.mjs';

const elapsed = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const quiet = 20000;

// `keyless` (a start by the front door, whose log this is): the ready lines
// leave out the dev-key link, so the door's files never hold a key.
export function printer({ json, stopHint, keyless = false, root }) {
 const started = Date.now();
 let current = 'preparing', last = Date.now();
 const event = (name, fields) => process.stdout.write(JSON.stringify({ version: 1, verb: 'dev', event: name, ...fields }) + '\n');
 const line = text => process.stderr.write(`rer dev: ${text}\n`);
 const progress = (phase, message) => {
  last = Date.now();
  if (json) event('progress', { phase, message, elapsedSeconds: Math.round((last - started) / 1000) });
  else line(message);
 };
 return {
  phase({ phase, message }) { if (phase !== 'note') current = message; progress(phase, message); },
  attaching(startedAt) { progress('attach', `attaching to the launch already preparing this checkout (started ${elapsed(Date.now() - startedAt)} ago)`); },
  heartbeat() { if (Date.now() - last >= quiet) progress('waiting', `still ${current} (${elapsed(Date.now() - started)}). Allow up to 10 minutes; if this command is stopped, run rer dev again to reattach.`); },
  // The dispatcher's ready event, as its own human ready lines.
  async ready(ready, { log, pid }) {
   if (keyless) { const { openUrl, ...rest } = ready; ready = rest; }
   if (json) { event('server', { pid, log }); process.stdout.write(JSON.stringify(ready) + '\n'); return; }
   const out = [...readySummary(ready), ...await launchSummary(root), '', 'Details for tools and troubleshooting:', `RER_READY ${ready.url}`];
   if (ready.openUrl) {
    if (ready.signedInAs) out.push(`RER_SIGNED_IN ${ready.signedInAs}`);
    out.push(`RER_OPEN ${ready.openUrl}`);
   }
   // A seed with a run site: its static homepage, /run and docs, served locally.
   if (ready.siteUrl) out.push(`RER_SITE ${ready.siteUrl}`);
   out.push(`The server keeps running in the background${pid ? ` (PID ${pid})` : ''}. Stop it with: ${stopHint}`);
   if (log) out.push(`Server log (private): ${log}`);
   process.stdout.write(out.join('\n') + '\n');
  },
  failure(failure) {
   if (json) {
    if (failure.event) process.stdout.write(JSON.stringify(failure.event) + '\n');
    else event('error', { code: 'launch_refused', message: failure.message, exitCode: failure.exitCode });
    event('result', { ok: false, exitCode: failure.exitCode });
   } else process.stderr.write(failure.message + '\n');
  },
 };
}
