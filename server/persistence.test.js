import { describe, expect, it, vi } from "vitest";
import { withTransaction } from "./db.js";
import { loadServerConfig } from "./config.js";
import { listMigrations } from "./migrate.js";
import { PersistenceConflictError, PersistenceValidationError, walletAddress } from "./validation.js";
import { createPersistenceRepository } from "./repositories.js";

describe("persistence configuration", () => {
  it("requires a database URL outside explicit local test mode", () => {
    expect(() => loadServerConfig({}, { allowMissingDatabase: false })).toThrow(/DATABASE_URL/);
    expect(loadServerConfig({}, { allowMissingDatabase: true }).databaseUrl).toBeNull();
  });

  it("normalizes and validates wallet addresses", () => {
    expect(walletAddress("0xD1b4367Dd9F235f9Ee61878019D66e31511e98Ee")).toBe("0xd1b4367dd9f235f9ee61878019d66e31511e98ee");
    expect(() => walletAddress("not-an-address")).toThrow(PersistenceValidationError);
  });

  it("validates the isolated Fuji staging configuration", () => {
    const config = loadServerConfig({ DATABASE_URL: "postgres://staging", NODE_ENV: "production", PUBLIC_APP_URL: "https://staging.example.com", AUTH_DOMAIN: "https://staging.example.com", AUTH_URI: "https://staging.example.com/login", API_ALLOWED_ORIGINS: "https://staging.example.com", INDEXER_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc", INDEXER_CHAIN_ID: "43113", INDEXER_CONTRACTS_JSON: '[{"address":"0x1111111111111111111111111111111111111111","contractType":"MARKETPLACE","startBlock":10}]', MARKETPLACE_ADDRESS: "0x2222222222222222222222222222222222222222", MARKETPLACE_CHAIN_ID: "43113" });
    expect(config.indexer.chainId).toBe(43113);
    expect(config.indexer.contracts[0].startBlock).toBe(10);
    expect(() => loadServerConfig({ DATABASE_URL: "postgres://staging", NODE_ENV: "production", PUBLIC_APP_URL: "https://staging.example.com", AUTH_DOMAIN: "https://staging.example.com", AUTH_URI: "https://staging.example.com/login", API_ALLOWED_ORIGINS: "https://staging.example.com", INDEXER_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc", INDEXER_CHAIN_ID: "43114", MARKETPLACE_ADDRESS: "0x2222222222222222222222222222222222222222", MARKETPLACE_CHAIN_ID: "43113" })).toThrow(/43113/);
  });

  it("allows production Fuji API configuration before marketplace deployment", () => {
    const config = loadServerConfig({ DATABASE_URL: "postgres://staging", NODE_ENV: "production", PUBLIC_APP_URL: "https://staging.example.com", AUTH_DOMAIN: "https://staging.example.com", AUTH_URI: "https://staging.example.com/login", API_ALLOWED_ORIGINS: "https://staging.example.com", INDEXER_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc", INDEXER_CHAIN_ID: "43113", INDEXER_CONTRACTS_JSON: '[{"address":"0x1111111111111111111111111111111111111111","contractType":"ERC1155","startBlock":10}]' });
    expect(config.marketplace).toMatchObject({ enabled: false, status: "not_configured", address: null, chainId: null });
  });

  it("keeps configured marketplace validation strict", () => {
    const base = { DATABASE_URL: "postgres://staging", NODE_ENV: "production", PUBLIC_APP_URL: "https://staging.example.com", AUTH_DOMAIN: "https://staging.example.com", AUTH_URI: "https://staging.example.com/login", API_ALLOWED_ORIGINS: "https://staging.example.com", INDEXER_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc", INDEXER_CHAIN_ID: "43113", INDEXER_CONTRACTS_JSON: '[{"address":"0x1111111111111111111111111111111111111111","contractType":"MARKETPLACE","startBlock":10}]' };
    expect(() => loadServerConfig({ ...base, MARKETPLACE_ADDRESS: "not-an-address", MARKETPLACE_CHAIN_ID: "43113" })).toThrow(/MARKETPLACE_ADDRESS/);
    expect(() => loadServerConfig({ ...base, MARKETPLACE_ADDRESS: "0x2222222222222222222222222222222222222222", MARKETPLACE_CHAIN_ID: "43114" })).toThrow(/43113/);
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
});

describe("migration inventory", () => {
  it("discovers numbered SQL migrations in deterministic order", async () => {
    await expect(listMigrations()).resolves.toEqual(["001_initial_persistence.sql", "002_api_idempotency.sql", "003_indexer_state.sql", "004_marketplace_commerce.sql", "005_wallet_auth.sql", "006_private_media.sql"]);
  });
});
