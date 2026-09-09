import process from "node:process";

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadServerConfig(env = process.env, { allowMissingDatabase = false } = {}) {
  const databaseUrl = String(env.DATABASE_URL || "").trim();
  if (!databaseUrl && !allowMissingDatabase) throw new ConfigurationError("DATABASE_URL is required for the persistence layer.");
  return Object.freeze({
    databaseUrl: databaseUrl || null,
    databaseSsl: String(env.DATABASE_SSL || "true").toLowerCase() !== "false",
    poolMax: positiveInteger(env.DATABASE_POOL_MAX, 10),
    poolIdleTimeoutMs: positiveInteger(env.DATABASE_POOL_IDLE_TIMEOUT_MS, 30000),
    poolConnectionTimeoutMs: positiveInteger(env.DATABASE_POOL_CONNECTION_TIMEOUT_MS, 5000),
    appEnvironment: String(env.NODE_ENV || "development"),
    publicAppUrl: String(env.PUBLIC_APP_URL || "http://localhost:5173").replace(/\/$/, ""),
  });
}
