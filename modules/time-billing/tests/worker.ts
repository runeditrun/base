import { createTimeBilling } from '../index.ts';
import { TimeBillingError } from '../errors.ts';
import { context, options, type Env } from './native.ts';
import type { Context, TimeBilling } from '../types.ts';

function encode(_key: string, value: unknown): unknown { return value instanceof Uint8Array ? { $bytes: [...value] } : value; }
function decode(_key: string, value: unknown): unknown { return value && typeof value === 'object' && '$bytes' in value ? new Uint8Array((value as { $bytes: number[] }).$bytes) : value; }
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body, encode), { status, headers: { 'Content-Type': 'application/json' } }); }
const commands = new Set(['recordEntry', 'startTimer', 'stopTimer', 'submit', 'decide', 'correct', 'lock', 'rate', 'preparePacket', 'commitClaims', 'cancelClaims', 'restoreRecords']);

async function legacy(request: Request, env: Env, ctx: Context): Promise<Response> {
  const member = await env.DB.prepare('SELECT can_finance FROM native_memberships WHERE installation=? AND person_id=? AND work_id=? AND active=1').bind(ctx.installationId, ctx.personId, 'project-1').first<{ can_finance: number }>();
  if (!member?.can_finance) throw new TimeBillingError('forbidden');
  if (request.method === 'POST') {
    const stopped = await env.DB.prepare('SELECT old_writer_stopped FROM native_control WHERE installation=?').bind(ctx.installationId).first<{ old_writer_stopped: number }>();
    if (stopped?.old_writer_stopped) throw new TimeBillingError('conflict', 'Legacy writer stopped at migration completion.');
    const { id, note } = await request.json() as { id: string; note: string };
    const result = await env.DB.prepare("UPDATE native_legacy_time SET entry_body=json_set(entry_body,'$.historical.note',?) WHERE installation=? AND id=? AND EXISTS(SELECT 1 FROM native_control WHERE installation=? AND old_writer_stopped=0)").bind(note, ctx.installationId, id, ctx.installationId).run();
    if (!result.meta.changes) throw new TimeBillingError('conflict');
    return json({ written: true });
  }
  const row = await env.DB.prepare('SELECT entry_body,packet_body,claim_body,artifact_bytes FROM native_legacy_time WHERE installation=? AND id=?').bind(ctx.installationId, 'legacy-entry').first<{ entry_body: string; packet_body: string; claim_body: string; artifact_bytes: ArrayBuffer }>();
  if (!row) throw new TimeBillingError('not_found');
  return json({ entry: JSON.parse(row.entry_body), packet: JSON.parse(row.packet_body), claims: [JSON.parse(row.claim_body)], bytes: new Uint8Array(row.artifact_bytes) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const ctx = await context(request, env.DB);
      if (url.pathname === '/api/legacy/time') return await legacy(request, env, ctx);
      const service = createTimeBilling(await options(env.DB, ctx));
      if (request.method === 'GET' && url.pathname.startsWith('/api/time/entries/')) return json(await service.readEntry(ctx, decodeURIComponent(url.pathname.slice('/api/time/entries/'.length))));
      if (request.method === 'GET' && url.pathname.startsWith('/api/time/packets/')) return json(await service.readPacket(ctx, decodeURIComponent(url.pathname.slice('/api/time/packets/'.length))));
      if (request.method === 'GET' && url.pathname === '/api/time/export') return json(await service.exportRecords(ctx, { kind: url.searchParams.get('kind')!, id: url.searchParams.get('id')! }));
      const action = url.pathname.slice('/api/time/commands/'.length);
      if (request.method === 'POST' && url.pathname.startsWith('/api/time/commands/') && commands.has(action)) {
        const input = JSON.parse(await request.text(), decode);
        const command = service[action as keyof TimeBilling] as (context: Context, input: unknown) => Promise<unknown>;
        return json(await command(ctx, input));
      }
      return json({ code: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof TimeBillingError) return json({ code: error.code, message: error.message }, error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : ['conflict', 'locked'].includes(error.code) ? 409 : 400);
      return json({ code: 'unexpected', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};
