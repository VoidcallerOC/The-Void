import pg from "pg";
import { loadServerConfig } from "./config.js";

const { Pool } = pg;

export function createDatabasePool(config = loadServerConfig()) {
  if (!config.databaseUrl) throw new Error("Cannot create a database pool without DATABASE_URL.");
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.poolConnectionTimeoutMs,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    application_name: "voidcaller-persistence",
  });
}

export async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabaseHealth(pool) {
  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1 AS ok");
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: error.message };
  }
}

export async function closeDatabasePool(pool) {
  if (pool) await pool.end();
}
