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
});

describe("migration inventory", () => {
  it("discovers numbered SQL migrations in deterministic order", async () => {
    await expect(listMigrations()).resolves.toEqual(["001_initial_persistence.sql", "002_api_idempotency.sql", "003_indexer_state.sql"]);
  });
});
