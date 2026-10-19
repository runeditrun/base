import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ownerProvider } from '../../modules/deploy-kit/tests/owner-provider.mjs';

export const manifest = { steps: [{ type: 'owner-claim', mode: 'signed', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN', path: '/auth/owner-claim' }],
 fields: [{ name: 'SESSION_SECRET', kind: 'secret', generate: 'hex' }, { name: 'SETUP_TOKEN', kind: 'secret', generate: 'hex' }] };

export async function checkout(t, declaration) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-deploy-owner-'))); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default {scheduled(){},fetch(){}}');
 await writeFile(join(root, 'dist/client/index.html'), 'app');
 await writeFile(join(root, 'migrations/core/0001_owner.sql'), 'CREATE TABLE owner(id TEXT PRIMARY KEY);');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', d1: [{ binding: 'DB' }], vars:{MAIL_PROVIDER:'resend',MAIL_FROM:'owner@example.test',...(!declaration.secrets?.some(item=>item.binding==='MAIL_API_KEY')?{MAIL_API_KEY:'test-only-outbound-key'}:{})}, ...declaration }));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.dev.vars\ndeploy.env\n');
 // The local setup's private settings: the owner rer deploy reuses.
 await writeFile(join(root, '.dev.vars'), 'OWNER_EMAIL=owner@example.test\nSESSION_SECRET=local-only-session\n', { mode: 0o600 });
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'first');
 return { root, git };
}

export function account(t) {
 const provider = ownerProvider(), claims = [], claimBodies = [];
 let denied = false;
 const saved = Object.fromEntries(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'MAIL_API_KEY', 'SESSION_SECRET', 'SETUP_TOKEN', 'OWNER_EMAIL', 'PUBLIC_ORIGIN', 'PIER_SESSION'].map(name => [name, process.env[name]]));
 for (const name of Object.keys(saved)) delete process.env[name];
 Object.assign(process.env, { CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token });
 t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } provider.close(); });
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input);
  if (url.hostname.endsWith('.workers.dev') && url.pathname === '/auth/bootstrap') {
   const body = JSON.parse(init.body), live = provider.state.secrets.find(item => item.name === 'SETUP_TOKEN')?.value;
   claimBodies.push(body);
   claims.push({ origin: init.headers.Origin, matches: body.token === live });
   if (!live || body.token !== live) return Response.json({ error: 'invalid_token' }, { status: 403 });
   if (denied) return Response.json({ error: 'owner_claim_denied' }, { status: 403 });
   const binding = provider.state.settings.bindings.find(item => item.name === 'DB');
   const { db } = provider.state.databases.find(row => row.uuid === binding.id);
   if (db.prepare('SELECT id FROM owner').get()) return Response.json({ error: 'already_initialized' }, { status: 409 });
   db.prepare('INSERT INTO owner(id) VALUES (?)').run('owner@example.test');
   return new Response(null, { status: 303, headers: { Location: '/' } });
  }
  return provider.fetch(input, init);
 });
 return { provider, claims, claimBodies, deny: value => { denied = value; } };
}

export const lifecycle = { run: async () => {}, settings: {}, hooks: { owner: { existingOwnerViaSignIn: true, displayName: input => input.displayName || 'Owner' } } };
export const store = () => { const lines = []; return { lines, state: {}, report: line => lines.push(line), step: async line => lines.push(line), phase: async () => {} }; };
