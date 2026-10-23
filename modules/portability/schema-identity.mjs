import { tokens } from './generated.mjs';
import { canonicalJson, sha256 } from './hash.mjs';

// D1 and local migration splitters retain different comments and spacing.
// Compare lexical tokens, preserving quoted identifiers, literal contents and
// operator boundaries. In particular, whitespace inside a default is data.
export function schemaSQL(sql) {
 return canonicalJson(tokens(sql).flatMap(token => token.quoted ? [token.text]
  : token.text.match(/[\p{L}\p{N}_$]+|->>|->|==|!=|<>|<=|>=|<<|>>|\|\||./gu)));
}
export const schemaIdentityOf = tables => sha256(canonicalJson(tables.map(({ name, sql }) => ({ name, sql: schemaSQL(sql) }))));
// Old archives authenticated the literal sqlite_master SQL. Verify those bytes
// first, then normalize only their compatibility view, never their archive proof.
export const rawSchemaIdentityOf = tables => sha256(canonicalJson(tables.map(({ name, sql }) => ({ name, sql }))));
