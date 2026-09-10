import { createHash } from "node:crypto";
import process from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createDatabasePool, checkDatabaseHealth } from "./db.js";
import { loadServerConfig } from "./config.js";
import { listMigrations } from "./migrate.js";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
export async function validateDatabase({ pool = null, config = loadServerConfig(), directory = migrationsDirectory } = {}) {
  const ownPool = pool || createDatabasePool(config);
  try {
    const health = await checkDatabaseHealth(ownPool);
    if (!health.ok) throw new Error(`Database is not reachable: ${health.error}`);
    const migrations = await listMigrations(directory);
    const applied = (await ownPool.query("SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name")).rows;
    const byName = new Map(applied.map((row) => [row.name, row]));
    const expected = [];
    for (const name of migrations) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      expected.push({ name, checksum });
      if (!byName.has(name)) throw new Error(`Migration is not applied: ${name}`);
      if (byName.get(name).checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
    }
    const unknown = applied.filter((row) => !expected.some((item) => item.name === row.name));
    if (unknown.length) throw new Error(`Database contains unknown migrations: ${unknown.map((row) => row.name).join(", ")}`);
    return { ok: true, health, migrations: expected.map((item) => ({ ...item, appliedAt: byName.get(item.name).applied_at })) };
  } finally { if (!pool) await ownPool.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) validateDatabase().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
