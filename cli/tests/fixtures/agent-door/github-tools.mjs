import { defineTool, ToolRefusal } from '../../../../modules/agent-door/index.ts';

export function githubTools(env) {
 return [defineTool({ name: 'fixture.github.claim', title: 'Sign a GitHub App claim', description: 'Validate the native GitHub connection and sign an App JWT with its PKCS8 key.', scope: 'records:read', readOnly: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { verified: { type: 'boolean' } }, required: ['verified'], additionalProperties: false }, classes: ['standard'], clauses: ['BASE-AGENT-002'], classify: () => [{ class: 'standard', facts: { measure: 1 } }],
  async run() {
   try {
    const value = JSON.parse(env.GITHUB_CONNECTION);
    if (Object.keys(value).sort().join(',') !== 'appId,installationId,privateKey' || !/^\d{1,20}$/.test(value.appId) || !/^\d{1,20}$/.test(value.installationId)) throw new Error();
    const bytes = Uint8Array.from(atob(value.privateKey.replace(/-----[^-]+-----|\s/g, '')), char => char.charCodeAt(0));
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    const key = await crypto.subtle.importKey('pkcs8', bytes, algorithm, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const publicKey = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, algorithm, false, ['verify']);
    const encode = value => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const iat = Math.floor(Date.now() / 1000), input = new TextEncoder().encode(`${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: value.appId, iat, exp: iat + 300 })}`);
    const signature = await crypto.subtle.sign(algorithm, key, input);
    if (!await crypto.subtle.verify(algorithm, publicKey, signature, input)) throw new Error();
    return { result: { verified: true } };
   } catch { throw new ToolRefusal('github_connection_invalid'); }
  },
 })];
}
