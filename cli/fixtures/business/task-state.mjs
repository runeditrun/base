import { actionBody, classificationOutput, closed, exportOutputs, identifier, integer, requireValue } from './contract.mjs';

const expires = () => new Date(Date.now() + 600_000).toISOString();
const numeric = ['page', 'total', 'records_done', 'bytes_done', 'progress'];

export function taskStore(state) {
 const records = new WeakMap(), events = new Map();
 let active;
 function find(id) {
  const summary = state.tasks.find(task => task.task_id === id);
  requireValue(summary, 404);
  if (!records.has(summary)) records.set(summary, { summary, phase: summary.state, fence: summary.fence ?? 0, checkpoint: {}, grants: new Map(), lease: null });
  const task = records.get(summary);
  if (task === active) Object.assign(task, { phase: state.phase, fence: state.fence, checkpoint: state.checkpoint });
  return task;
 }
 function sync(task) {
  task.summary.state = task.phase; task.summary.fence = task.fence;
  active = task;
  Object.assign(state, { phase: task.phase, fence: task.fence, checkpoint: task.checkpoint });
 }
 function runnable(task) { requireValue(task.summary.runner === 'executor', 403); }
 function view(task) {
  return { id: task.summary.task_id, business_id: 'biz', kind: task.summary.kind, kind_version: 1,
   state: task.phase, fence: task.fence, lease_expires_at: task.phase === 'leased' ? task.lease : null,
   checkpoint: Object.fromEntries(numeric.filter(key => Number.isSafeInteger(task.checkpoint[key]) && task.checkpoint[key] >= 0).map(key => [key, task.checkpoint[key]])),
   ...(task.summary.question ? { question: task.summary.question } : {}) };
 }
 function summary(task) { return { ...task.summary, state: task.phase, fence: task.fence }; }
 function grant(task, fence) {
  const value = task.grants.get(fence);
  requireValue(value, 409);
  return { ...value, uploaded_bytes: state.grants.get(value.id) ?? 0 };
 }
 function reply(task, fence = task.fence, replayed = false) {
  return { task: view(task), fence: task.fence, grant: grant(task, fence),
   lease_expires_at: task.phase === 'leased' ? task.lease : null, heartbeat_interval_seconds: 60, replayed };
 }
 function claimTask(task) {
  runnable(task); requireValue(task.phase === 'ready', 409);
  task.phase = 'leased'; task.fence++; task.lease = expires();
  const id = `grant-${task.summary.task_id}-${task.fence}`, local = task.summary.kind === 'discover.local';
  // A vendor export names its app's import door once that door is ready (platform grantView).
  const door = task.summary.kind === 'export.vendor' && state.door;
  task.grants.set(task.fence, { id, task_id: task.summary.task_id, fence: task.fence,
   destination: local ? state.destination ?? `/api/business/tasks/${encodeURIComponent(task.summary.task_id)}/uploads` : task.summary.kind === 'classify.row' ? 'none' : door ? `${door.origin}/api/rer/import/uploads` : 'unavailable:no-linked-installation',
   quota_bytes: local ? state.quotaBytes ?? 2 * 1024 * 1024 : door ? 2 * 1024 * 1024 : 0,
   ...(local || task.summary.kind === 'classify.row' ? {} : door ? { import_grants: `/api/business/tasks/${encodeURIComponent(task.summary.task_id)}/import-grants` } : { available: false, reason: 'no-linked-installation' }),
   consent: local ? { id: 'consent1', scope: { paths: [state.root] } } : null });
  state.grants.set(id, state.uploadedBytes ?? 0); sync(task);
 }
 function claim(body) {
  closed(body, ['claim_id', 'task_id', 'wait_seconds']);
  requireValue(typeof body.claim_id === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.claim_id));
  if (body.task_id !== undefined) requireValue(typeof body.task_id === 'string' && body.task_id.length > 0 && body.task_id.length <= 512);
  if (body.wait_seconds !== undefined) integer(body.wait_seconds, 25);
  const signature = JSON.stringify({ claim_id: body.claim_id, task_id: body.task_id ?? null });
  const prior = state.claims.get(body.claim_id);
  if (prior) {
   requireValue(prior.signature === signature, 409);
   return reply(find(prior.taskId), prior.fence, true);
  }
  const candidate = body.task_id ? find(body.task_id) : state.tasks.map(item => find(item.task_id)).find(item => item.phase === 'ready' && item.summary.runner === 'executor');
  if (!candidate) return { task: null, heartbeat_interval_seconds: 60 };
  runnable(candidate);
  if (candidate.phase !== 'ready') return { task: null, heartbeat_interval_seconds: 60 };
  claimTask(candidate);
  state.claims.set(body.claim_id, { signature, taskId: candidate.summary.task_id, fence: candidate.fence });
  return reply(candidate);
 }
 function action(id, action, body, mcp = false) {
  actionBody(action, body, mcp);
  const task = find(id); runnable(task);
  if (action === 'complete' && task.summary.kind === 'export.vendor') exportOutputs(body.outputs);
  else if (body.outputs !== undefined) {
   if (task.summary.kind === 'classify.row') classificationOutput(body.outputs, task.summary.question?.answer_schema);
   else requireValue(Object.keys(body.outputs).length === 0, 409);
  }
  const signature = JSON.stringify({ id, action, body });
  const prior = events.get(body.client_event_id);
  if (prior) {
   requireValue(prior.signature === signature, 409);
   return { ...reply(task, prior.fence, true), ...(action === 'heartbeat' ? heartbeatControls(body) : {}), ...(action === 'uploads' ? { stored: body.document.signals.length } : {}) };
  }
  if (action === 'claim') {
   requireValue(task.fence === body.fence, 409); claimTask(task);
  } else {
   const bound = grant(task, body.fence);
   requireValue(bound.id === body.grant_id && task.fence === body.fence && task.phase === 'leased' && Date.parse(task.lease) > Date.now(), 409);
   if (action === 'uploads') {
    requireValue(task.summary.kind === 'discover.local' && bound.quota_bytes > 0, 409);
    requireValue(body.consent_id === bound.consent.id, 403);
    const doc = body.document; closed(doc, ['schema', 'source', 'signals', 'withheld']);
    requireValue(doc.schema === 'rer-business-signals/1' && doc.source === 'local' && Array.isArray(doc.signals) && doc.signals.length > 0);
    integer(doc.withheld);
    for (const signal of doc.signals) {
     closed(signal, ['kind', 'value', 'locator', 'repo', 'class', 'observedAt', 'size', 'mtime']);
     requireValue(['kind', 'value', 'locator', 'observedAt'].every(key => typeof signal[key] === 'string') && ['live-use', 'trace'].includes(signal.class));
     if (signal.repo !== undefined) requireValue(typeof signal.repo === 'string');
     if (signal.size !== undefined) integer(signal.size);
     if (signal.mtime !== undefined) requireValue(typeof signal.mtime === 'string');
    }
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    requireValue(bound.uploaded_bytes + bytes <= bound.quota_bytes, 409);
    state.uploads.push(doc); state.grants.set(bound.id, bound.uploaded_bytes + bytes);
   }
   if (action === 'heartbeat') { if (body.checkpoint !== undefined) task.checkpoint = body.checkpoint; task.lease = expires(); }
   if (action === 'complete') {
    if (task.summary.kind === 'classify.row') {
     requireValue(!state.refuseQuestion && body.outputs !== undefined, 409);
     state.questionCompleted = body.outputs;
    } else if (task.summary.kind === 'export.vendor') {
     // The platform's check (exportPreviewCheck): the door holds the reported plan, for the reported upload, of exactly the reported bundle.
     const { upload_id, plan_id, bundle_sha256 } = body.outputs;
     requireValue(state.door?.state.plans.some(plan => plan.planId === plan_id && plan.uploadId === upload_id && plan.bundleSha256 === bundle_sha256 && !plan.failureCode), 409, 'business_export_preview_mismatch');
    } else requireValue(task.summary.kind === 'discover.local' && state.uploads.length > 0, 409);
    task.phase = 'done'; task.lease = null;
   }
   if (action === 'release') {
    state.released = body;
    if (task.summary.kind === 'classify.row') state.questionReleased = true;
    if (body.checkpoint !== undefined) task.checkpoint = body.checkpoint;
    task.phase = body.reason === 'failed' ? 'failed' : 'ready'; task.fence++; task.lease = null;
   }
   sync(task);
  }
  const fence = action === 'claim' ? task.fence : body.fence;
  events.set(body.client_event_id, { signature, fence });
  const result = { ...reply(task, fence), ...(action === 'heartbeat' ? heartbeatControls(body) : {}), ...(action === 'uploads' ? { stored: body.document.signals.length } : {}) };
  if (action === 'heartbeat') state.onHeartbeat?.();
  if (action === 'release') state.onRelease?.();
  return result;
 }
 function heartbeatControls(body) { return { controls: [], cursor: body.cursor ?? 0, cancel_requested: false }; }
 /** POST /api/business/tasks/:taskId/import-grants (platform executors/grants.ts issueImportGrant). */
 function importGrant(id, body) {
  closed(body, ['fence', 'grant_id', 'action']); integer(body.fence); identifier(body.grant_id);
  requireValue(['uploads', 'plan', 'status'].includes(body.action));
  const task = find(id); runnable(task);
  requireValue(task.summary.kind === 'export.vendor', 409);
  const bound = grant(task, body.fence);
  requireValue(bound.id === body.grant_id && task.fence === body.fence && task.phase === 'leased' && Date.parse(task.lease) > Date.now() && state.door, 409);
  state.importGrants = (state.importGrants ?? 0) + 1;
  const namespace = state.exportVendor ?? 'uptimerobot';
  return { destination: `${state.door.origin}/api/rer/import/${body.action}`, authorization: `Bearer ${state.door.mint(body.action, namespace)}`,
   action: body.action, namespace, expires_at: new Date(Date.now() + 300_000).toISOString() };
 }
 return { find, summary, claim, action, importGrant };
}
