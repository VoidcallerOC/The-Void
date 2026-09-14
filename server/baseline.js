import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createDatabasePool } from "./db.js";
import { loadServerConfig } from "./config.js";
import { advisoryLockKey, listMigrations, migrationsDirectory } from "./migrate.js";

export const baselineMigrationName = "001_initial_persistence.sql";
export const baselineMigrationChecksum = "3a34827e1253e19d26a05cd054f25c46acb046bc8b556dd8aa2320cb29ac9475";

const schemaMigrationsDdl = "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())";

export class BaselineMismatchError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "BaselineMismatchError";
    this.report = report;
  }
}

function quoteIdentifier(name) { return `"${String(name).replace(/"/g, '""')}"`; }

export function stripTransactionControl(sql) {
  if (/^\s*(ROLLBACK|SAVEPOINT)\b/im.test(sql)) throw new Error("Baseline verification cannot replay SQL containing ROLLBACK or SAVEPOINT statements.");
  return sql.replace(/^[ \t]*(BEGIN|COMMIT|END)[ \t]*;[ \t]*$/gim, "").trim();
}

export function requiredExtensions(sql) {
  return [...sql.matchAll(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)].map((match) => match[1].toLowerCase());
}

function normalizeDefinition(text, schemas) {
  if (text === null || text === undefined) return null;
  let normalized = String(text);
  for (const schema of schemas) {
    if (!schema) continue;
    normalized = normalized.split(`${quoteIdentifier(schema)}.`).join("").split(`${schema}.`).join("");
  }
  return normalized.replace(/\s+/g, " ").trim();
}

async function readSchema(client, schema, normalizeSchemas) {
  const columns = await client.query(
    `SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expression
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE n.nspname = $1 AND c.relkind = 'r'
     ORDER BY c.relname, a.attname`,
    [schema],
  );
  const constraints = await client.query(
    `SELECT c.relname AS table_name, con.conname AS constraint_name, pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'
     ORDER BY c.relname, con.conname`,
    [schema],
  );
  const indexes = await client.query("SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname", [schema]);
  const tables = new Set(columns.rows.map((row) => row.table_name));
  return {
    tables,
    columns: new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, { table: row.table_name, column: row.column_name, type: row.data_type, notNull: row.not_null, default: normalizeDefinition(row.default_expression, normalizeSchemas) }])),
    constraints: new Map(constraints.rows.map((row) => [`${row.table_name}.${row.constraint_name}`, { table: row.table_name, name: row.constraint_name, definition: normalizeDefinition(row.definition, normalizeSchemas) }])),
    indexes: new Map(indexes.rows.map((row) => [`${row.table_name}.${row.index_name}`, { table: row.table_name, name: row.index_name, definition: normalizeDefinition(row.definition, normalizeSchemas) }])),
  };
}

function describeColumn(column) { return `${column.type}${column.notNull ? " NOT NULL" : ""}${column.default ? ` DEFAULT ${column.default}` : ""}`; }

export function compareSchemas(expected, actual, { allowExtraObjects = false } = {}) {
  const missing = [];
  const differing = [];
  const extra = [];
  for (const table of expected.tables) if (!actual.tables.has(table)) missing.push({ kind: "table", name: table });
  const relevantTables = expected.tables;
  for (const [key, column] of expected.columns) {
    const live = actual.columns.get(key);
    if (!live) { if (actual.tables.has(column.table)) missing.push({ kind: "column", name: key }); continue; }
    if (describeColumn(column) !== describeColumn(live)) differing.push({ kind: "column", name: key, expected: describeColumn(column), actual: describeColumn(live) });
  }
  for (const [key, constraint] of expected.constraints) {
    const live = actual.constraints.get(key);
    if (!live) { if (actual.tables.has(constraint.table)) missing.push({ kind: "constraint", name: key, expected: constraint.definition }); continue; }
    if (constraint.definition !== live.definition) differing.push({ kind: "constraint", name: key, expected: constraint.definition, actual: live.definition });
  }
  for (const [key, index] of expected.indexes) {
    const live = actual.indexes.get(key);
    if (!live) { if (actual.tables.has(index.table)) missing.push({ kind: "index", name: key, expected: index.definition }); continue; }
    if (index.definition !== live.definition) differing.push({ kind: "index", name: key, expected: index.definition, actual: live.definition });
  }
  for (const [key, column] of actual.columns) if (relevantTables.has(column.table) && !expected.columns.has(key)) extra.push({ kind: "column", name: key, actual: describeColumn(column) });
  for (const [key, constraint] of actual.constraints) if (relevantTables.has(constraint.table) && !expected.constraints.has(key)) extra.push({ kind: "constraint", name: key, actual: constraint.definition });
  for (const [key, index] of actual.indexes) if (relevantTables.has(index.table) && !expected.indexes.has(key)) extra.push({ kind: "index", name: key, actual: index.definition });
  return { missing, differing, extra, compatible: missing.length === 0 && differing.length === 0 && (allowExtraObjects || extra.length === 0) };
}

function formatReport(report) {
  const lines = [];
  for (const item of report.missing) lines.push(`missing ${item.kind}: ${item.name}${item.expected ? ` (expected ${item.expected})` : ""}`);
  for (const item of report.differing) lines.push(`differing ${item.kind}: ${item.name}\n    expected: ${item.expected}\n    actual:   ${item.actual}`);
  for (const item of report.extra) lines.push(`unexpected ${item.kind}: ${item.name} (${item.actual})`);
  return lines.map((line) => `  - ${line}`).join("\n");
}

async function extensionSchema(client, extension) {
  const result = await client.query("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1", [extension]);
  return result.rows[0] ? result.rows[0].schema : null;
}

async function verifyAgainstShadowSchema(client, sql, { allowExtraObjects }) {
  const shadow = `void_baseline_shadow_${randomBytes(6).toString("hex")}`;
  const extensionSchemas = [];
  for (const extension of requiredExtensions(sql)) {
    const schema = await extensionSchema(client, extension);
    if (!schema) throw new BaselineMismatchError(`Required extension is not installed: ${extension}`, { missing: [{ kind: "extension", name: extension }], differing: [], extra: [], compatible: false });
    if (!extensionSchemas.includes(schema)) extensionSchemas.push(schema);
  }
  await client.query("BEGIN");
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(shadow)}`);
    const searchPath = [quoteIdentifier(shadow), "public", ...extensionSchemas.filter((schema) => schema !== "public").map(quoteIdentifier)].join(", ");
    await client.query(`SET LOCAL search_path TO ${searchPath}`);
    await client.query(stripTransactionControl(sql));
    const normalizeSchemas = [shadow, "public", ...extensionSchemas];
    const expected = await readSchema(client, shadow, normalizeSchemas);
    const actual = await readSchema(client, "public", normalizeSchemas);
    return compareSchemas(expected, actual, { allowExtraObjects });
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function baselineDatabase({ pool = null, config = loadServerConfig(), directory = migrationsDirectory, name = baselineMigrationName, expectedChecksum = baselineMigrationChecksum, allowExtraObjects = false, dryRun = false } = {}) {
  const ownPool = pool || createDatabasePool(config);
  const client = await ownPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    const sql = await readFile(join(directory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (expectedChecksum && checksum !== expectedChecksum) {
      throw new BaselineMismatchError(`Baseline migration checksum does not match the pinned baseline checksum for ${name}. Expected ${expectedChecksum}, computed ${checksum}. Baselining an edited migration is refused.`, { missing: [], differing: [{ kind: "checksum", name, expected: expectedChecksum, actual: checksum }], extra: [], compatible: false });
    }
    const migrationsTable = (await client.query("SELECT to_regclass('public.schema_migrations') AS table")).rows[0].table;
    const records = migrationsTable ? (await client.query("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows : [];
    const existing = records.find((row) => row.name === name);
    if (existing) {
      if (existing.checksum !== checksum) throw new BaselineMismatchError(`Database already records ${name} with checksum ${existing.checksum}, which differs from the repository checksum ${checksum}. Refusing to modify migration history.`, { missing: [], differing: [{ kind: "checksum", name, expected: checksum, actual: existing.checksum }], extra: [], compatible: false });
      return { baselined: false, reason: "already-recorded", name, checksum, applied: records.map((row) => row.name) };
    }
    if (records.length) throw new BaselineMismatchError(`Database records migrations (${records.map((row) => row.name).join(", ")}) but not ${name}. This is not a baselining case; resolve the migration history manually.`, { missing: [{ kind: "migration-record", name }], differing: [], extra: records.map((row) => ({ kind: "migration-record", name: row.name, actual: row.checksum })), compatible: false });
    const report = await verifyAgainstShadowSchema(client, sql, { allowExtraObjects });
    if (!report.compatible) throw new BaselineMismatchError(`Live schema does not match the intended result of ${name}; no changes were made.\n${formatReport(report)}`, report);
    if (dryRun) return { baselined: false, reason: "dry-run", name, checksum, report, applied: records.map((row) => row.name) };
    await client.query("BEGIN");
    try {
      await client.query(schemaMigrationsDdl);
      const inserted = await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING name", [name, checksum]);
      await client.query("COMMIT");
      return { baselined: inserted.rowCount > 0, reason: inserted.rowCount > 0 ? "recorded" : "already-recorded", name, checksum, report, applied: (await client.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((row) => row.name) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]).catch(() => {});
    client.release();
    if (!pool) await ownPool.end();
  }
}

export async function pendingMigrationsAfterBaseline({ directory = migrationsDirectory, name = baselineMigrationName } = {}) {
  return (await listMigrations(directory)).filter((migration) => migration > name);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--check");
  const allowExtraObjects = process.argv.includes("--allow-extra-objects");
  baselineDatabase({ dryRun, allowExtraObjects })
    .then((result) => console.log(JSON.stringify({ ...result, report: undefined })))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
