export { default } from './journey.mjs';

export async function afterStep({ phase, step, result, request, origin, cookie }) {
 if (step.id !== 'create') return;
 if (!(['autonomous', 'held'].includes(phase) || phase.startsWith('blocked:')) || !result?.id) throw new Error('Missing completed native creation');
 const response = await request(new URL('/app/repository-consent', origin).href, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: result.id }) });
 if (!response.ok) throw new Error('Native repository consent failed');
 await response.body?.cancel();
}
