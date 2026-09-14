import { createHash } from "node:crypto";
import process from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createDatabasePool, checkDatabaseHealth } from "./db.js";
import { loadServerConfig } from "./config.js";
import { listMigrations } from "./migrate.js";
import { requiredExtensions } from "./baseline.js";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function declaredTables(sql) {
  return [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)].map((match) => match[1].toLowerCase());
}

async function inspectSchemaObjects(pool, tables, extensions) {
  const presentTables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((row) => row.table_name);
  const presentExtensions = (await pool.query("SELECT extname FROM pg_extension")).rows.map((row) => row.extname);
  const missingTables = tables.filter((table) => !presentTables.includes(table));
  const missingExtensions = extensions.filter((extension) => !presentExtensions.includes(extension));
  if (missingTables.length) throw new Error(`Database is missing required tables: ${missingTables.join(", ")}`);
  if (missingExtensions.length) throw new Error(`Database is missing required extensions: ${missingExtensions.join(", ")}`);
  return { tables: tables.length, extensions, verifiedTables: tables };
}

export async function validateDatabase({ pool = null, config = loadServerConfig(), directory = migrationsDirectory } = {}) {
  const ownPool = pool || createDatabasePool(config);
  try {
    const health = await checkDatabaseHealth(ownPool);
    if (!health.ok) throw new Error(`Database is not reachable: ${health.error}`);
    const migrations = await listMigrations(directory);
    const applied = (await ownPool.query("SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name")).rows;
    const byName = new Map(applied.map((row) => [row.name, row]));
    const expected = [];
    const tables = new Set();
    const extensions = new Set();
    for (const name of migrations) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      for (const table of declaredTables(sql)) tables.add(table);
      for (const extension of requiredExtensions(sql)) extensions.add(extension);
      expected.push({ name, checksum });
      if (!byName.has(name)) throw new Error(`Migration is not applied: ${name}`);
      if (byName.get(name).checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
    }
    const unknown = applied.filter((row) => !expected.some((item) => item.name === row.name));
    if (unknown.length) throw new Error(`Database contains unknown migrations: ${unknown.map((row) => row.name).join(", ")}`);
    const schema = await inspectSchemaObjects(ownPool, [...tables], [...extensions]);
    return { ok: true, health, schema, migrations: expected.map((item) => ({ ...item, appliedAt: byName.get(item.name).applied_at })) };
  } finally { if (!pool) await ownPool.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) validateDatabase().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
