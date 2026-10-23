import { readFile, readdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { splitStatements } from '../../modules/portability/sql-text.mjs';

const root = new URL('../../', import.meta.url);
const source = path => readFile(new URL(path, root), 'utf8');
const ddl = sql => /^(?:(?:\s+)|(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))*(?:CREATE|ALTER|DROP)\b/i.test(sql);
const statements = (origin, sql) => splitStatements(sql).filter(ddl).map((sql, index) => ({ origin: `${origin}:${index + 1}`, sql }));

// Read only these static data expressions. Importing runtime.mjs also resolves
// Miniflare, esbuild and its runtime lease; the corpus needs none of them.
async function fixtureExpression(path, name, pattern) {
  const match = (await source(path)).match(pattern);
  if (!match) throw new Error(`Cannot find static ${name} in ${path}`);
  return runInNewContext(match[1], Object.create(null), { timeout: 1000 });
}

// Each entry is one statement. grammar-probe origins deliberately include
// token sequences SQLite cannot store as a view (notably parameters). They
// exercise lexical boundaries, and must not be executed as schema fixtures.
export const probeStatements = [
  ['table/invoices', `CREATE TABLE invoices (
    id TEXT PRIMARY KEY, x TEXT, a INTEGER, b INTEGER, e1 REAL,
    quantity INTEGER CHECK(quantity >= 7),
    label TEXT DEFAULT 'keep -- /* alpha */',
    total INTEGER GENERATED ALWAYS AS (quantity * 125) STORED
  )`],
  ['table/audit', 'CREATE TABLE audit(message TEXT, x TEXT)'],
  ['index', 'CREATE UNIQUE INDEX invoice_quantity ON invoices(quantity DESC) WHERE quantity > 0'],
  ['view', 'CREATE VIEW invoice_totals AS SELECT quantity+1 AS next FROM invoices'],
  ['trigger', `CREATE TRIGGER invoice_added AFTER INSERT ON invoices BEGIN
    INSERT INTO audit(message) VALUES('alpha; -- /* literal */');
    UPDATE audit SET x=CASE WHEN NEW.quantity>7 THEN 'yes' ELSE 'no' END;
  END`],
  ['trigger/raise', `CREATE TRIGGER invoice_checked BEFORE INSERT ON invoices
    WHEN NEW.quantity < 7 BEGIN SELECT RAISE(ABORT, 'abort'); END`],
  ['blob', "CREATE VIEW invoice_blob AS SELECT x'31' AS value FROM invoices"],
  ['string-alias', "CREATE VIEW invoice_alias AS SELECT x '31' FROM invoices"],
  ['minus', 'CREATE VIEW invoice_minus AS SELECT a -b AS value FROM invoices'],
  ['minus/unary', 'CREATE VIEW invoice_double_minus AS SELECT a - -b AS value FROM invoices'],
  ['operators', `CREATE VIEW invoice_operators AS SELECT
    a||b AS concat, x->'$.a' AS json, x->>'$.a' AS scalar,
    a<=b AS le, a<>b AS ne, a!=b AS unequal, a<<b AS shift_left,
    a>>b AS shift_right, a==b AS eq, a>=b AS ge,
    a+b AS plus, a*b AS product, a/b AS quotient, a%b AS remainder,
    a&b AS bit_and, a|b AS bit_or, ~a AS complement FROM invoices`],
  ['numbers', `CREATE VIEW invoice_numbers AS SELECT
    0 AS zero, 123 AS integer_value, 1. AS trailing_dot, .5 AS leading_dot,
    1.25 AS decimal_value, 1e1 AS exponent, 1E+2 AS positive_exponent,
    1.2e-3 AS negative_exponent, 0x1f AS hex_value, 0XFF AS upper_hex,
    1_000 AS separated_integer, 1_2.3_4e+5_6 AS separated_float,
    0x1_f AS separated_hex`],
  ['quotes', 'CREATE TABLE "quoted""table" (`back``tick` TEXT, [bracket name] TEXT, "éclair" TEXT)'],
  ['single-quoted-table', "CREATE TABLE 'single quoted table' (value TEXT)"],
  ['single-quoted-column', "CREATE TABLE single_quoted_column ('single quoted column' TEXT)"],
  ['strings', `CREATE VIEW invoice_strings AS SELECT
    'it''s -- not /* a comment */; []' AS escaped, '' AS empty_string,
    X'00aAff' AS blob_value, x'' AS empty_blob`],
  ['identifiers', 'CREATE VIEW invoice_identifiers AS SELECT _a, a$b, élan, "a.b", [a b], `a-b` FROM invoices'],
  ['default/upper', 'CREATE TABLE fallback_upper (x TEXT DEFAULT ABORT)'],
  ['default/lower', 'CREATE TABLE fallback_lower (x TEXT DEFAULT abort)'],
  ['default/quoted', `CREATE TABLE fallback_quoted (x TEXT DEFAULT 'ABORT', y TEXT DEFAULT 'abort')`],
  ['case', `CREATE VIEW invoice_case AS SELECT CASE WHEN a IS NULL THEN 'ABORT'
    WHEN a BETWEEN 1 AND 2 THEN 'abort' ELSE x END AS value FROM invoices`],
  ['generated', `CREATE TABLE generated_invoice (quantity INTEGER, price INTEGER,
    total INTEGER AS (quantity * price) STORED,
    label TEXT AS ('total: ' || total) VIRTUAL)`],
  ['grammar-probe/dot-exponent', 'CREATE VIEW invoice_dot_exponent AS SELECT 1 .e1 FROM invoices'],
  ['grammar-probe/split-operators', 'CREATE VIEW invoice_split_operators AS SELECT a | | b, a < > b, a < < b, a > > b, a = = b, a - > b, a - > > b, a / * b FROM invoices'],
  ['grammar-probe/adjacent-quotes', `CREATE VIEW invoice_adjacent_quotes AS SELECT 'a' 'b', "a" "b", \`a\` \`b\`, [a] [b], x '31', X '00' FROM invoices`],
  ['grammar-probe/adjacent-numbers', 'CREATE VIEW invoice_adjacent_numbers AS SELECT 0 x1, 1 e1, 1 .e1, . 5, 0x1 f FROM invoices'],
  ['grammar-probe/adjacent-variables', 'CREATE VIEW invoice_adjacent_variables AS SELECT ? 123, :name name, $x (suffix) FROM invoices'],
  ['grammar-probe/parameters', 'CREATE VIEW invoice_parameters AS SELECT ?, ?123, :name, @name, $::x::(a-b), #name FROM invoices'],
].map(([origin, sql]) => ({ origin: origin.startsWith('grammar-probe/') ? origin : `probe/${origin}`, sql }));

/** Real repository DDL, plus isolated statements covering SQLite token classes. */
export async function schemaCorpus() {
  const migrationDirectory = 'default-seed/migrations/core/';
  const paths = (await readdir(new URL(migrationDirectory, root))).filter(path => path.endsWith('.sql')).sort();
  const migrations = await Promise.all(paths.map(async path => {
    const origin = migrationDirectory + path;
    return statements(origin, await source(origin));
  }));
  const runtimePath = 'modules/portability/tests/runtime.mjs';
  const generatedPath = 'cli/fixtures/portability.mjs';
  const archivePath = 'modules/portability/tests/fixtures/bookkeeping-v2.jsonl';
  const [runtimeSQL, generatedSQL, portabilitySQL, archive] = await Promise.all([
    fixtureExpression(runtimePath, 'fixtureSQL', /^export const fixtureSQL=(\[[\s\S]*?\n\]);/m),
    fixtureExpression(generatedPath, 'generatedSQL', /^export const generatedSQL=(`[^`]*`);/m),
    source('modules/portability/schema/portability.sql'),
    source(archivePath),
  ]);
  if (!Array.isArray(runtimeSQL) || runtimeSQL.some(sql => typeof sql !== 'string') || typeof generatedSQL !== 'string') {
    throw new Error('Schema corpus fixture exports must contain static SQL strings');
  }
  const manifest = JSON.parse(archive.split('\n')[0]);
  return [
    ...migrations.flat(),
    ...runtimeSQL.flatMap((sql, index) => statements(`${runtimePath}:fixtureSQL[${index}]`, sql)),
    ...statements(`${generatedPath}:generatedSQL`, generatedSQL),
    ...statements('modules/portability/schema/portability.sql', portabilitySQL),
    ...manifest.tables.map(table => ({ origin: `${archivePath}:${table.name}`, sql: table.sql })),
    ...probeStatements,
  ];
}
