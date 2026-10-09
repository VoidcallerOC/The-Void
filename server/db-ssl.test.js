import { describe, expect, it } from "vitest";
import { connectionStringForPool, createDatabasePool } from "./db.js";
import { ConfigurationError, loadServerConfig } from "./config.js";

describe("managed Postgres SSL connection strings", () => {
  it("removes sslmode=require so pg does not override rejectUnauthorized=false", () => {
    const result = connectionStringForPool("postgres://user:pass@db.example/postgres?sslmode=require&connect_timeout=5", false);
    expect(result).toBe("postgres://user:pass@db.example/postgres?connect_timeout=5");
  });

  it("preserves ssl parameters when certificate verification remains enabled", () => {
    const input = "postgres://user:pass@db.example/postgres?sslmode=verify-full";
    expect(connectionStringForPool(input, true)).toBe(input);
  });
});

describe("database certificate verification with DATABASE_SSL_CA", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";
  const url = "postgres://user:pass@db.example/postgres?sslmode=require";

  it("keeps the current sslmode=require behaviour when no CA is configured", () => {
    const config = loadServerConfig({ DATABASE_URL: url });
    expect(config.databaseSslCa).toBeNull();
    expect(config.databaseSslRejectUnauthorized).toBe(false);
  });

  it("verifies the server certificate against the configured CA, accepting single-line \\n escapes", () => {
    const config = loadServerConfig({ DATABASE_URL: url, DATABASE_SSL_CA: PEM.replace(/\n/g, "\\n") });
    expect(config.databaseSslCa).toBe(PEM);
    expect(config.databaseSslRejectUnauthorized).toBe(true);
    const pool = createDatabasePool(config);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(pool.options.connectionString).not.toMatch(/sslmode/);
    return pool.end();
  });

  it("rejects a malformed CA and a CA combined with disabled verification", () => {
    expect(() => loadServerConfig({ DATABASE_URL: url, DATABASE_SSL_CA: "not a cert" })).toThrow(ConfigurationError);
    expect(() => loadServerConfig({ DATABASE_URL: url, DATABASE_SSL_CA: PEM, DATABASE_SSL_REJECT_UNAUTHORIZED: "false" })).toThrow(/requires certificate verification/);
  });
});
