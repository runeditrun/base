import type { SqlDatabase } from '../../core/database.ts';
import type { TokenAuthority } from '../../core/types.ts';

// Native consumer authority schema and authenticated caller fixture, test-only.
export const issuerSchema = `CREATE TABLE issuers (
  namespace TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
  active INTEGER NOT NULL, scopes TEXT NOT NULL, PRIMARY KEY(namespace,id)
)`;
export async function installIssuer(sql: SqlDatabase, namespace = 'tenant') {
  await sql.batch([
    { sql: issuerSchema },
    { sql: 'INSERT INTO issuers VALUES(?,?,1,1,?)', params: [namespace, 'owner', '["read","write"]'] },
  ]);
}
export function nativeAuthority(sql: SqlDatabase, namespace = 'tenant'): TokenAuthority<{ principal: string }> {
  return {
    async grant(context) {
      const [rows] = await sql.batch([{ sql: 'SELECT * FROM issuers WHERE namespace=? AND id=? AND active=1', params: [namespace, context.principal] }]);
      const issuer = rows![0];
      if (!issuer) throw new Error('Forbidden');
      return {
        scopes: JSON.parse(String(issuer.scopes)),
        commitGuard: { sql: 'SELECT 1 FROM issuers WHERE namespace=? AND id=? AND revision=? AND active=1', params: [namespace, context.principal, Number(issuer.revision)] },
      };
    },
    async administer(context) {
      const [rows] = await sql.batch([{ sql: 'SELECT 1 FROM issuers WHERE namespace=? AND id=? AND active=1', params: [namespace, context.principal] }]);
      if (!rows!.length) throw new Error('Forbidden');
    },
  };
}
export const owner = { principal: 'owner' };
