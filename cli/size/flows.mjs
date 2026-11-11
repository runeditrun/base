import { RerError } from '../errors.mjs';
import { pathFor, sendAs, upgradeHeaders } from './personas.mjs';

// Runs the declared flows on one installed size, each through the rows-read meter: a request flow makes its request
// as its persona and reads the whole response; a websocket flow upgrades, waits for the first server message or 2 s
// and closes; a scheduled flow runs the Worker's scheduled handler with its cron and the run's :now. A flow's window
// closes when the response is read, its waitUntil work has settled and no statement has been recorded for 250 ms.

const socketWaitMs = 2000;

const sum = (statements, key) => statements.reduce((all, statement) => all + statement[key], 0);

// The text a person reads for what a flow does: "GET /path", "WS /path" or "cron * * * * *".
export function flowLabel(flow) {
 return flow.scheduled !== undefined ? `cron ${flow.scheduled}` : `${flow.request.websocket ? 'WS' : flow.request.method} ${flow.request.path}`;
}

const kindOf = flow => flow.scheduled !== undefined ? 'scheduled' : flow.request.websocket ? 'websocket' : 'request';

// Waits for the first message of an accepted socket, its close or an error, or the time, then closes it.
async function firstMessage(socket) {
 socket.accept();
 await new Promise(resolve => {
  const timer = setTimeout(resolve, socketWaitMs);
  for (const event of ['message', 'close', 'error']) socket.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
 });
 try { socket.close(1000, 'size check'); } catch {}
}

// One run of one flow inside a window: { status, error?, ms }.
async function once(flow, { hosted, personas, now }) {
 const started = performance.now();
 try {
  if (flow.scheduled !== undefined) {
   await (await hosted.preparation()).scheduled({ scheduledTime: now, cron: flow.scheduled });
   return { status: 'ok', ms: performance.now() - started };
  }
  if (flow.request.websocket) {
   const response = await hosted.upgrade(pathFor(personas, flow).replace(/^\//, ''), { headers: upgradeHeaders(personas, flow, hosted.origin) });
   if (response.status === 101 && response.webSocket) await firstMessage(response.webSocket);
   else await response.arrayBuffer();
   return { status: response.status, ms: performance.now() - started };
  }
  const response = await sendAs(personas, flow);
  const body = await response.text();
  // What an error answered, so a 404 or 500 says why.
  return { status: response.status, ...(response.status >= 400 ? { detail: body.replace(/\s+/g, ' ').trim().slice(0, 240) } : {}), ms: performance.now() - started };
 } catch (error) {
  if (error instanceof RerError && ['size_flow_failed', 'size_persona_failed'].includes(error.code)) throw error;
  return { status: null, error: String(error?.message ?? error).slice(0, 300), ms: performance.now() - started };
 }
}

/**
 * Runs `flow` `repeat` times on the install and resolves its measurement from the last run (earlier runs warm what
 * the app caches): { name, kind, persona, label, runs, rowsRead, rowsWritten, statements, status, error?, ms,
 * unsettled, executions }. `executions` lists each statement the last run executed, in order.
 */
export async function runFlow(flow, install) {
 let last;
 for (let run = 0; run < flow.repeat; run++) {
  const window = install.meter.open();
  let outcome;
  try { outcome = await once(flow, install); }
  catch (error) { await window.close({ quietMs: 0, maxMs: 0 }); throw error; }
  const { statements, unsettled } = await window.close();
  last = { ...outcome, unsettled, executions: statements, rowsRead: sum(statements, 'rows_read'), rowsWritten: sum(statements, 'rows_written'), statements: statements.length };
 }
 return { name: flow.name, kind: kindOf(flow), persona: flow.persona ?? null, label: flowLabel(flow), runs: flow.repeat, ...last };
}

/** Every declared flow, in order, on one install: resolves the list of runFlow results. `each(flow, work)` runs one
 * flow's work (the run's clock names the flow it stopped in). */
export async function runFlows(flows, install, each = (flow, work) => work()) {
 const results = [];
 for (const flow of flows) {
  const result = await each(flow, () => runFlow(flow, install));
  results.push(result);
 }
 return results;
}
