import type { DoorRequest, ImportDoorOptions } from './types.ts';
import type { DoorAction } from './grants.ts';
import { DoorError } from './grants.ts';
import { admit, enabled, erasedSince } from './authority.ts';
import { authorized } from './store.ts';
import { sizeLimitError } from './limits.ts';
import { requestDatabase } from '../d1/budget.ts';
import { uploads } from './uploads.ts';
import { plan } from './planning.ts';
import { apply, status, reconcile, undo } from './jobs.ts';
export type * from './types.ts';
export type { DoorAction, DoorGrant } from './grants.ts';
export { verifyImportGrant, DoorError } from './grants.ts';
export { importDoorSchema, importDoorApplyFailureMigration, importDoorScopesMigration } from './schema.ts';
export { writeImportDoorSettings, readImportDoorHistory } from './authority.ts';

const routes = {uploads,plan,apply,status,reconcile,undo};
const headers = {'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
async function readInput(request: Request): Promise<Record<string,unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json' || !request.body) throw new DoorError('json_body_required',400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 100_000) throw new DoorError('request_too_large',413);
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part,offset); offset += part.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw new DoorError('invalid_json',400); }
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new DoorError('invalid_input',400);
  return value;
}
/** Server-side mount only. A null response belongs to another dispatcher. */
export function createImportDoorHandler(options: ImportDoorOptions): (request: Request)=>Promise<Response|null> {
  if (!options.ownerPrincipalId?.trim() || !options.destination?.trim() || !options.mapping?.version || typeof options.parse!=='function') throw new DoorError('invalid_configuration',503);
  return async request => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/rer/import/')) return null;
    let admitted: DoorRequest | undefined;
    try {
      // Every statement of this request, the door's own and each kit call's,
      // counts in one D1 request budget; exhausting it is a named 413.
      const budgeted = {...options,database:requestDatabase(options.database)};
      // Check opt-in before revealing routes, authentication, or parser behavior.
      if (!await enabled(budgeted)) return Response.json({error:'not_found'},{status:404,headers});
      const action = url.pathname.slice('/api/rer/import/'.length) as DoorAction;
      if (!Object.hasOwn(routes,action)) return Response.json({error:'not_found'},{status:404,headers});
      if (request.method!=='POST') return Response.json({error:'method_not_allowed'},{status:405,headers:{...headers,Allow:'POST'}});
      if (url.search || url.hash) throw new DoorError('query_transport_forbidden',400);
      admitted = await admit(budgeted,request,action); const input = await readInput(request);
      if (['status','reconcile','undo'].includes(action) && Object.keys(input).some(k=>k!=='planId')) throw new DoorError('invalid_input',400);
      const result = await routes[action](admitted,input);
      await authorized(admitted);
      return Response.json(result,{headers});
    } catch (caught) {
      // Work an erasure overtook answers one stable refusal, whichever batch it reached.
      const overtaken = admitted && (!(caught instanceof DoorError) || caught.code === 'grant_revoked_or_expired') && await erasedSince(admitted).catch(() => false);
      // A kit size limit is a named 413.
      const error = overtaken ? new DoorError('erased_during_request', 410) : sizeLimitError(caught) ?? caught;
      const known = error instanceof DoorError;
      // Never reflect a parser/native adapter error containing customer records.
      return Response.json({error:known?error.code:'import_door_conflict',...(known && error.details?{details:error.details}:{})},{status:known?error.status:409,headers});
    }
  };
}
