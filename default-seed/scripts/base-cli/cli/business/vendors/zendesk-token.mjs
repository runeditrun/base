import { fail, object } from './common.mjs';

export const SCOPES = Object.freeze(['tickets:read', 'users:read', 'organizations:read', 'hc:read', 'ticket_attachments:read']);
export function clientCredential(key) {
 let value;
 try { value = JSON.parse(key); } catch { fail('INVALID_KEY'); }
 if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join() !== 'client_id,client_secret'
  || Object.values(value).some(part => typeof part !== 'string' || !part || part.length > 4096 || /[\u0000-\u0020\u007f]/u.test(part))) fail('INVALID_KEY');
 return value;
}
export function originOf(inputs) {
 const account = inputs?.account;
 if (!account || Object.keys(account).join() !== 'subdomain' || typeof account.subdomain !== 'string'
  || !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/u.test(account.subdomain)) fail('INVALID_INPUT');
 if (!['snapshot', 'sweep', 'census', 'retire'].includes(inputs.mode ?? 'snapshot')
  || inputs.highWater !== undefined && (!Number.isSafeInteger(inputs.highWater) || inputs.highWater < 0)) fail('INVALID_INPUT');
 return `https://${account.subdomain}.zendesk.com`;
}
export async function mintToken(request, key) {
 const credential = clientCredential(key);
 const { body } = await request('/oauth/tokens', { method: 'POST', json: { ...credential, grant_type: 'client_credentials', scope: SCOPES.join(' '), expires_in: 1800 }, authenticated: false, tokenResponse: true });
 object(body);
 if (typeof body.access_token !== 'string' || !body.access_token || body.access_token.length > 8192 || /[\u0000-\u0020\u007f]/u.test(body.access_token)
  || body.token_type?.toLowerCase() !== 'bearer') fail('INVALID_TOKEN');
 request.authorize(body.access_token);
 const current = await request('/api/v2/oauth/tokens/current', { tokenResponse: true });
 const scopes = current.body?.token?.scopes ?? current.body?.scopes;
 const values = typeof scopes === 'string' ? scopes.split(/\s+/u) : scopes;
 if (!Array.isArray(values) || !values.length || values.some(scope => !['read', ...SCOPES].includes(scope))) fail('KEY_NOT_READ_ONLY');
 return body.access_token;
}
