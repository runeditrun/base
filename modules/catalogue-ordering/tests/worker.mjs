import { createCatalogueOrdering, restoreHistory, verifyExportArtifact } from '../index.ts';
import { nativeOptions } from './native-adapters.mjs';

const failure = code => Response.json({ ok: false, error: { code } });
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // This Worker exists only in tests. Neither private control is an app route.
    if (url.pathname === '/__test/verify' && request.method === 'POST') return Response.json(await verifyExportArtifact(await request.json()));
    if (url.pathname === '/__test/restore' && request.method === 'POST') return Response.json(await restoreHistory(env.DB, await request.json()));
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!token) return failure('authority_refused');
    const session = await env.DB.prepare(`SELECT s.* FROM native_sessions s JOIN native_people p ON p.installation=s.installation AND p.id=s.person_id
      WHERE s.token=? AND s.active=1 AND p.active=1`).bind(token).first();
    if (!session) return failure('authority_refused');
    const context = { installation: session.installation, actor: { personId: session.person_id } };
    const service = createCatalogueOrdering(nativeOptions(env.DB, session));
    if (url.pathname.startsWith('/snapshot/') && request.method === 'GET') return Response.json(await service.readSnapshot(context, { id: decodeURIComponent(url.pathname.slice('/snapshot/'.length)) }));
    const routes = { '/offers': 'listOffers', '/selection': 'resolveSelection', '/draft': 'saveDraft', '/review': 'reviewSelection', '/commit': 'freezeSelection', '/export': 'exportRecords' };
    const method = routes[url.pathname];
    if (!method || request.method !== 'POST') return new Response('Not found', { status: 404 });
    let input;
    try { input = await request.json(); } catch { return failure('invalid_input'); }
    return Response.json(await service[method](context, input));
  },
};
