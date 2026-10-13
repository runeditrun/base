/** Compile-only consumer contract: deployment-owned ports are required inputs. */
import {
  D1SqlDatabase, IntegrationsRepository, DeliveryService, TokenService,
  createWebhookProtocol, createSlackBotProtocol, createSlackIncomingWebhookProtocol,
  declareEgress, validateEgressConfiguration,
} from '../../index.ts';
import type {
  D1Binding, TrustedTransport, TokenAuthority, TokenGrant, TokenRequestContext,
  SlackBotResolver, SlackWebhookResolver, Envelope, DeliveryProtocol, SqlDatabase,
} from '../../index.ts';
import { SqliteDatabase } from '../../core/sqlite.ts';
import { NodePinnedTransport } from '../../core/node-transport.ts';

export interface AuthenticatedContext { readonly operatorId: string }
export interface DeploymentPorts {
  namespace: string;
  webhookDestination(id: string): Promise<string>;
  webhookKey(envelope: Envelope): Promise<Uint8Array>;
  slackBot: SlackBotResolver;
  slackWebhook: SlackWebhookResolver;
  tokenAuthority: TokenAuthority<AuthenticatedContext>;
}
export function connect(sql: SqlDatabase, transport: TrustedTransport, ports: DeploymentPorts) {
  const repository = new IntegrationsRepository(sql, ports.namespace);
  const protocols: DeliveryProtocol[] = [
    createWebhookProtocol({ resolveDestination: ports.webhookDestination, signingKey: ports.webhookKey }),
    createSlackBotProtocol({ resolveDestination: ports.slackBot }),
    createSlackIncomingWebhookProtocol({ resolveDestination: ports.slackWebhook }),
  ];
  return { repository, tokens: new TokenService(repository, ports.tokenAuthority),
    delivery: new DeliveryService({ repository, transport, protocols }) };
}
export function connectWorker(binding: D1Binding, enforcingEgress: TrustedTransport, ports: DeploymentPorts) {
  return connect(new D1SqlDatabase(binding), enforcingEgress, ports);
}
export function connectNode(path: string, ports: DeploymentPorts) {
  const sql = new SqliteDatabase(path);
  return { ...connect(sql, new NodePinnedTransport(), ports), close: () => sql.close() };
}
export async function tokenConsumer(tokens: TokenService<AuthenticatedContext>, actor: AuthenticatedContext, request: TokenRequestContext) {
  const issued = await tokens.issue(actor, { name: 'Incident reader', scopes: ['incidents:read'] });
  const result = await tokens.authorize(issued.token, ['incidents:read'], request);
  await tokens.revoke(actor, issued.credential.id);
  return { result, safeList: await tokens.list(actor), usage: await tokens.usage(actor) };
}
export function nativeGrant(scopes: string[], namespace: string, operatorId: string, revision: number): TokenGrant {
  return { scopes, commitGuard: { sql: 'SELECT 1 FROM native_issuers WHERE namespace=? AND id=? AND revision=? AND active=1', params: [namespace, operatorId, revision] } };
}
export const egress = declareEgress({ id: 'incident-webhook', required: true,
  provider: { id: 'customer-system', name: 'Customer incident service' },
  destination: { kind: 'custom', id: 'receiver-v1', description: 'Authorized incident receiver' },
  why: 'The customer receives incident updates in its own system.', dataFields: ['incident ID', 'public summary'],
  adapters: ['integrations.webhook.v1'], custody: [{ name: 'WEBHOOK_KEY_HEX', purpose: 'Signs incident webhooks' }],
});
export function validateConsumerDestination(url: string, keyHex: string) {
  return validateEgressConfiguration(egress, { providerId: 'customer-system', destinationId: 'receiver-v1', destinationUrl: url, secrets: { WEBHOOK_KEY_HEX: keyHex } });
}
