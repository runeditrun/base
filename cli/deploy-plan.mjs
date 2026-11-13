import { deployPermissions } from './deploy-needs.mjs';

// An offline plan knows the declared migrations, never which ones the hosted
// databases have applied. Keep that distinction in the human summary.
export function deployPlanLines(plan, declaration) {
 const lines = ['Would deploy:', `  Worker: ${plan.worker}`];
 for (const database of plan.d1) lines.push(`  D1 database: ${database.name} (${database.migrations.length} declared migration${database.migrations.length === 1 ? '' : 's'})`);
 if (!plan.d1.length) lines.push('  D1 databases: none');
 for (const [kind, label] of [['r2', 'R2 storage'], ['kv', 'KV storage'], ['queues', 'Queue'], ['services', 'Worker service']]) {
  for (const item of plan[kind]) lines.push(`  ${label}: ${item.name ?? item.service}`);
 }
 if (plan.durableObjects.length) lines.push(`  Durable Objects: ${plan.durableObjects.length}`);
 lines.push(`  Secret inputs: ${plan.secrets.filter(item => !item.optional).length} required, ${plan.secrets.filter(item => item.optional).length} optional`);
 lines.push(`  Public settings: ${plan.vars.length}; scheduled triggers: ${plan.crons.length}`);
 lines.push(`  Cloudflare token permissions: ${deployPermissions(declaration).join(', ')}`);
 lines.push('  Pending migrations: unknown until the hosted databases are checked.');
 return lines;
}
