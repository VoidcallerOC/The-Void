import ConnectionParameters from "pg/lib/connection-parameters.js";
import { describe, expect, it } from "vitest";
import { connectionStringForPool, createDatabasePool, isSupabaseDatabaseUrl } from "./db.js";
import { ConfigurationError, loadServerConfig } from "./config.js";

describe("managed Postgres SSL connection strings", () => {
  it("strips sslmode so pg cannot replace the explicit ssl object", () => {
    const result = connectionStringForPool("postgres://user:pass@db.example/postgres?sslmode=require&connect_timeout=5", true);
    expect(result).toBe("postgres://user:pass@db.example/postgres?connect_timeout=5");
  });

  it("strips sslmode=verify-full and sslrootcert when SSL params must not override the pool", () => {
    const input = "postgres://user:pass@db.example/postgres?sslmode=verify-full&sslrootcert=/tmp/root.crt";
    expect(connectionStringForPool(input, true)).toBe("postgres://user:pass@db.example/postgres");
  });

  it("leaves the URL unchanged when not stripping", () => {
    const input = "postgres://user:pass@db.example/postgres?sslmode=verify-full";
    expect(connectionStringForPool(input, false)).toBe(input);
  });
});

describe("database certificate verification with DATABASE_SSL_CA", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";
  const url = "postgres://user:pass@db.example/postgres?sslmode=require";
  const poolerUrl = "postgres://postgres.utgyamnzfcffjqmoboup:pass@aws-0-us-east-2.pooler.supabase.com:5432/postgres";
  const poolerWithSslmode = `${poolerUrl}?sslmode=require`;

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

  it("recognizes Supabase session-pooler hosts", () => {
    expect(isSupabaseDatabaseUrl(poolerUrl)).toBe(true);
    expect(isSupabaseDatabaseUrl("postgres://user:pass@db.example/postgres")).toBe(false);
  });

  it("refuses Supabase pooler verification without DATABASE_SSL_CA (avoids SELF_SIGNED_CERT_IN_CHAIN)", () => {
    // No sslmode=require → rejectUnauthorized defaults to true → needs the project CA.
    const config = loadServerConfig({ DATABASE_URL: poolerUrl, DATABASE_SSL: "true" });
    expect(config.databaseSslRejectUnauthorized).toBe(true);
    expect(config.databaseSslCa).toBeNull();
    expect(() => createDatabasePool(config)).toThrow(/DATABASE_SSL_CA/);
  });

  it("builds a verified Supabase session-pooler pool when DATABASE_SSL_CA is set", () => {
    const config = loadServerConfig({ DATABASE_URL: poolerWithSslmode, DATABASE_SSL: "true", DATABASE_SSL_CA: PEM });
    expect(config.databaseSslRejectUnauthorized).toBe(true);
    const pool = createDatabasePool(config);
    expect(pool.options.connectionString).not.toMatch(/sslmode/i);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    // pg must not let a leftover sslmode wipe the explicit ssl + CA object.
    const effective = new ConnectionParameters({ connectionString: pool.options.connectionString, ssl: pool.options.ssl });
    expect(effective.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    return pool.end();
  });

  it("still allows the legacy sslmode=require path without a CA (encrypt, no verify)", () => {
    const config = loadServerConfig({ DATABASE_URL: poolerWithSslmode, DATABASE_SSL: "true" });
    expect(config.databaseSslRejectUnauthorized).toBe(false);
    const pool = createDatabasePool(config);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: false });
    expect(pool.options.connectionString).not.toMatch(/sslmode/i);
    const effective = new ConnectionParameters({ connectionString: pool.options.connectionString, ssl: pool.options.ssl });
    expect(effective.ssl).toEqual({ rejectUnauthorized: false });
    return pool.end();
  });
});
