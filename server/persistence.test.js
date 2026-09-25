import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { withTransaction } from "./db.js";
import { loadServerConfig } from "./config.js";
import { listMigrations, migrationBody } from "./migrate.js";
import { PersistenceConflictError, PersistenceValidationError, walletAddress } from "./validation.js";
import { createPersistenceRepository } from "./repositories.js";

describe("persistence configuration", () => {
  it("requires a database URL outside explicit local test mode", () => {
    expect(() => loadServerConfig({}, { allowMissingDatabase: false })).toThrow(/DATABASE_URL/);
    expect(loadServerConfig({}, { allowMissingDatabase: true }).databaseUrl).toBeNull();
  });

  it("normalizes and validates wallet addresses", () => {
    expect(walletAddress("0xD1B4367Dd9F235f9Ee61878019D66e31511e98Ee")).toBe("0xd1b4367dd9f235f9ee61878019d66e31511e98ee");
    expect(() => walletAddress("not-an-address")).toThrow(PersistenceValidationError);
  });
});

describe("transaction handling", () => {
  it("commits successful callbacks and releases the client", async () => {
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    await expect(withTransaction(pool, async (tx) => { expect(tx).toBe(client); return "ok"; })).resolves.toBe("ok");
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back failed callbacks and preserves the original error", async () => {
    const failure = new Error("write failed");
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    await expect(withTransaction(pool, async () => { throw failure; })).rejects.toBe(failure);
    expect(client.query).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("repository contracts", () => {
  it("rejects invalid writes before making a database query", async () => {
    const db = { query: vi.fn() };
    const repository = createPersistenceRepository(db);
    await expect(repository.saveArtist({ id: "", slug: "voidcaller", displayName: "Voidcaller" })).rejects.toBeInstanceOf(PersistenceValidationError);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("maps a duplicate database constraint to a stable conflict error", async () => {
    const db = { query: vi.fn().mockRejectedValue({ code: "23505" }) };
    const repository = createPersistenceRepository(db);
    await expect(repository.saveArtist({ id: "artist-001", slug: "voidcaller", displayName: "Voidcaller" })).rejects.toBeInstanceOf(PersistenceConflictError);
  });

  it("persists only hashed auth secrets and atomically scopes nonce consumption", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ nonce_hash: "hashed-nonce" }] }) };
    const repository = createPersistenceRepository(db);
    await repository.createNonce({ nonceHash: "hashed-nonce", wallet: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", chainId: 43113, domain: "app.voidcaller.example", origin: "https://app.voidcaller.example", uri: "https://app.voidcaller.example", purpose: "wallet-auth", issuedAt: new Date("2026-09-09T20:00:00.000Z"), expiresAt: new Date("2026-09-09T20:05:00.000Z") });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO auth_nonces (nonce_hash"), expect.arrayContaining(["hashed-nonce"]));
    expect(db.query.mock.calls[0][1]).not.toContain("raw-nonce");

    await repository.consumeNonce({ nonceHash: "hashed-nonce", wallet: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", chainId: 43113, domain: "app.voidcaller.example", origin: "https://app.voidcaller.example", uri: "https://app.voidcaller.example", purpose: "wallet-auth" });
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("consumed_at IS NULL AND expires_at > now()"), ["hashed-nonce", "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", 43113, "app.voidcaller.example", "https://app.voidcaller.example", "https://app.voidcaller.example", "wallet-auth"]);

    await repository.createAuthSession({ sessionHash: "hashed-session", wallet: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", chainId: 43113, purpose: "wallet-auth", issuedAt: new Date("2026-09-09T20:00:00.000Z"), expiresAt: new Date("2026-09-09T21:00:00.000Z") });
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO auth_sessions (token_hash"), expect.arrayContaining(["hashed-session"]));
  });
});

describe("migration inventory", () => {
  it("discovers numbered SQL migrations in deterministic order", async () => {
    await expect(listMigrations()).resolves.toEqual(["001_initial_persistence.sql", "002_api_idempotency.sql", "003_indexer_state.sql", "004_marketplace_commerce.sql", "005_wallet_auth.sql", "006_private_media.sql", "007_migration_sequence_repair.sql", "008_wallet_auth.sql", "009_wallet_auth.sql", "010_marketplace_reconciliation.sql", "011_indexer_operations.sql", "012_artist_studio.sql", "013_artist_rls.sql", "014_artist_verification.sql", "015_artist_owned_media_assets.sql", "016_primary_purchases.sql", "017_rls_lockdown.sql", "018_contract_owner_verification.sql", "019_seed_voidcaller_legacy.sql", "020_legacy_ipfs_media.sql", "021_provenance_proofs.sql"]);
  });

  it("keeps migration bookkeeping and SQL body in one transaction boundary", async () => {
    expect(migrationBody("BEGIN;\nCREATE TABLE sample (id text);\nCOMMIT;", "sample.sql")).toBe("CREATE TABLE sample (id text);");
    expect(() => migrationBody("CREATE TABLE sample (id text);", "bad.sql")).toThrow(/outer BEGIN/);
    expect(() => migrationBody("BEGIN; CREATE TABLE sample (id text); COMMIT; COMMIT;", "nested.sql")).toThrow(/nested transaction/);
    const lockdown = await readFile(new URL("./migrations/017_rls_lockdown.sql", import.meta.url), "utf8");
    const body = migrationBody(lockdown, "017_rls_lockdown.sql");
    expect(body).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(body).not.toMatch(/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/);
    expect(body).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK|END)\s*;/);
  });
});
