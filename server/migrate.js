import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDatabasePool } from "./db.js";
import { loadServerConfig } from "./config.js";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const advisoryLockKey = 481562901;

export async function listMigrations(directory = migrationsDirectory) {
  return (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
}

export function migrationBody(sql, name = "migration") {
  const source = String(sql || "");
  const withoutBegin = source.replace(/^\s*BEGIN\s*;\s*/i, "");
  const body = withoutBegin.replace(/\s*COMMIT\s*;\s*$/i, "");
  if (body === source || !body.trim()) throw new Error(`Migration must contain one outer BEGIN/COMMIT transaction: ${name}`);
  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(body)) throw new Error(`Migration contains nested transaction control: ${name}`);
  return body;
}

export async function migrate({ pool = null, config = loadServerConfig(), directory = migrationsDirectory } = {}) {
  const ownPool = pool || createDatabasePool(config);
  const client = await ownPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of await listMigrations(directory)) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const body = migrationBody(sql, name);
      const existing = await client.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration checksum changed after application: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(body);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)", [name, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { applied: (await client.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((row) => row.name) };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]).catch(() => {});
    client.release();
    if (!pool) await ownPool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
}
