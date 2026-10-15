import pg from "pg";
import { ConfigurationError, loadServerConfig } from "./config.js";

const { Pool } = pg;

// Supabase session/transaction poolers present a cert chain rooted at the project CA,
// which is not in Node's default trust store. Verified TLS needs DATABASE_SSL_CA.
export function isSupabaseDatabaseUrl(connectionString) {
  try {
    const host = new URL(connectionString).hostname.toLowerCase();
    return host === "supabase.com" || host.endsWith(".supabase.com");
  } catch {
    return /\.supabase\.com(?::|\/|\?|$)/i.test(String(connectionString || ""));
  }
}

// node-pg does Object.assign({}, poolOptions, parse(connectionString)), so sslmode /
// sslrootcert / sslcert / sslkey in the URL replace any explicit `ssl` object. Strip them
// whenever we pass `ssl` ourselves — otherwise sslmode=require is treated as verify-full
// (empty ssl {}) and yields SELF_SIGNED_CERT_IN_CHAIN against Supabase without a CA.
export function connectionStringForPool(connectionString, stripSslParams = false) {
  if (!stripSslParams) return connectionString;
  try {
    const url = new URL(connectionString);
    for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return String(connectionString)
      .replace(/([?&])(sslmode|sslrootcert|sslcert|sslkey)=[^&]*/gi, "$1")
      .replace(/[?&]$/, "")
      .replace(/\?&+/, "?")
      .replace(/&&+/g, "&");
  }
}

export function createDatabasePool(config = loadServerConfig()) {
  if (!config.databaseUrl) throw new Error("Cannot create a database pool without DATABASE_URL.");
  const verifyCertificates = config.databaseSsl && config.databaseSslRejectUnauthorized !== false;
  if (verifyCertificates && !config.databaseSslCa && isSupabaseDatabaseUrl(config.databaseUrl)) {
    throw new ConfigurationError(
      "Supabase Postgres with certificate verification requires DATABASE_SSL_CA (PEM from Database Settings → SSL certificate). Do not disable TLS verification or set NODE_TLS_REJECT_UNAUTHORIZED=0.",
    );
  }
  const ssl = config.databaseSsl
    ? {
        rejectUnauthorized: config.databaseSslRejectUnauthorized !== false,
        ...(config.databaseSslCa ? { ca: config.databaseSslCa } : {}),
      }
    : false;
  return new Pool({
    connectionString: connectionStringForPool(config.databaseUrl, Boolean(ssl)),
    max: config.poolMax,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.poolConnectionTimeoutMs,
    ssl,
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
