import { describe, expect, it, vi } from "vitest";
import { IndexedOwnershipVerifier } from "./ownership.js";

const wallet = "0x1111111111111111111111111111111111111111";
const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const config = { authAllowedChainIds: [43113], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000 };

function checkpoint(overrides = {}) {
  return { status: "IDLE", last_processed_block: "100", latest_known_block: "104", last_successful_run_at: "2026-09-09T20:00:00.000Z", updated_at: "2026-09-09T20:00:00.000Z", ...overrides };
}

describe("indexed ownership verification", () => {
  it("grants only when the canonical index is fresh and holds the required token", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rows: [checkpoint()] }).mockResolvedValueOnce({ rows: [{ token_id: "7", amount: "1", synchronization_watermark: "100:2" }] }) };
    const verifier = new IndexedOwnershipVerifier({ db, config, now: () => new Date("2026-09-09T20:01:00.000Z") });
    await expect(verifier.verify({ wallet, experienceId: "experience-1", requirements: [{ type: "erc1155-balance", contract, tokenIds: ["7"], minAmount: 1, chainId: 43113 }] })).resolves.toMatchObject({ owns: true, state: "CONFIRMED", chainId: 43113, watermark: "43113:7:100:2" });
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("synchronization_watermark <> 'REORG_PENDING'"), [43113, contract, wallet, ["7"], "1"]);
  });

  it("fails closed while the indexer is stale, lagging, or has no matching balance", async () => {
    const staleDb = { query: vi.fn().mockResolvedValue({ rows: [checkpoint({ latest_known_block: "130" })] }) };
    const stale = new IndexedOwnershipVerifier({ db: staleDb, config, now: () => new Date("2026-09-09T20:01:00.000Z") });
    await expect(stale.verify({ wallet, requirements: [{ type: "erc1155-balance", contract, tokenIds: ["7"] }] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });

    const emptyDb = { query: vi.fn().mockResolvedValueOnce({ rows: [checkpoint()] }).mockResolvedValueOnce({ rows: [] }) };
    const empty = new IndexedOwnershipVerifier({ db: emptyDb, config, now: () => new Date("2026-09-09T20:01:00.000Z") });
    await expect(empty.verify({ wallet, requirements: [{ type: "erc1155-balance", contract, tokenIds: ["7"] }] })).resolves.toMatchObject({ owns: false, state: "CONFIRMED" });
  });

  it("fails closed for protected media when requirements are empty", async () => {
    const verifier = new IndexedOwnershipVerifier({ db: { query: vi.fn() }, config });
    await expect(verifier.verify({ wallet, requirements: [], mediaConfig: { protected: true, protectedMedia: [{ assetId: "asset-1", mediaType: "AUDIO" }] } })).resolves.toMatchObject({ owns: false, state: "CONFIRMED", watermark: null });
    await expect(verifier.verify({ wallet, requirements: [], mediaConfig: { protectedMedia: [{ storageKey: "bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234" }] } })).resolves.toMatchObject({ owns: false });
    await expect(verifier.verify({ wallet, requirements: [] })).resolves.toMatchObject({ owns: true, watermark: "NO_REQUIREMENT" });
    expect(verifier.db.query).not.toHaveBeenCalled();
  });

  it("rejects unsupported or malformed experience requirements", async () => {
    const verifier = new IndexedOwnershipVerifier({ db: { query: vi.fn() }, config });
    await expect(verifier.verify({ wallet, requirements: [{ type: "wallet-claim", contract, tokenIds: ["7"] }] })).rejects.toMatchObject({ code: "EXPERIENCE_REQUIREMENT_UNSUPPORTED" });
    await expect(verifier.verify({ wallet, requirements: [{ type: "erc1155-balance", contract: "bad", tokenIds: [] }] })).rejects.toMatchObject({ code: "EXPERIENCE_REQUIREMENT_INVALID" });
  });
});

// The indexer writes the new chain head into latest_known_block when a run starts, before
// last_processed_block moves. While a row is RUNNING those two columns come from different runs,
// so freshness is judged by the last successful completion instead (F-08).
describe("checkpoint freshness against the last completed run", () => {
  const requirement = { type: "erc1155-balance", contract, tokenIds: ["7"], minAmount: 1, chainId: 43113 };
  const snapshot = { token_id: "7", amount: "1", synchronization_watermark: "100:2" };
  const at = (iso) => () => new Date(iso);
  const verifierFor = (rows, { now, config: selected = config } = {}) => new IndexedOwnershipVerifier({ db: { query: vi.fn(async (sql) => (String(sql).includes("FROM indexer_checkpoints") ? { rows: [rows] } : { rows: [snapshot] })) }, config: selected, now });

  it("does not deny a holder while a run is in progress on a freshly completed index (production-shaped row)", async () => {
    // The release clone row observed in production at 03:26:27Z: RUNNING, head refreshed 91 blocks past
    // the previous run's progress, last success 68 s earlier. Chain 43114, the real token id.
    const mainnet = { ...config, authAllowedChainIds: [43114] };
    const clone = "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103";
    const tokenId = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
    const row = checkpoint({ status: "RUNNING", last_processed_block: "97933754", latest_known_block: "97933845", last_successful_run_at: "2026-10-19T03:25:19.000Z", updated_at: "2026-10-19T03:26:20.000Z" });
    const db = { query: vi.fn(async (sql) => (String(sql).includes("FROM indexer_checkpoints") ? { rows: [row] } : { rows: [{ token_id: tokenId, amount: "1", synchronization_watermark: "97933700:4" }] })) };
    const verifier = new IndexedOwnershipVerifier({ db, config: mainnet, now: at("2026-10-19T03:26:27.000Z") });
    await expect(verifier.verify({ wallet, experienceId: "full-track", requirements: [{ type: "erc1155-balance", contract: clone, tokenIds: [tokenId], minAmount: "1", chainId: 43114 }] }))
      .resolves.toMatchObject({ owns: true, state: "CONFIRMED", chainId: 43114, source: "indexer", watermark: `43114:${tokenId}:97933700:4` });
    // The decision still comes from the canonical snapshot for this wallet, contract, token, and amount.
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("synchronization_watermark <> 'REORG_PENDING'"), [43114, clone, wallet, [tokenId], "1"]);
  });

  it("fails closed while a run is in progress if the last successful completion is itself stale", async () => {
    const row = checkpoint({ status: "RUNNING", last_processed_block: "100", latest_known_block: "112", last_successful_run_at: "2026-09-09T20:00:00.000Z" });
    await expect(verifierFor(row, { now: at("2026-09-09T20:02:10.000Z") }).verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });
  });

  it("fails closed for a checkpoint that has never completed a run, however recently it was written", async () => {
    for (const status of ["RUNNING", "IDLE"]) {
      const row = checkpoint({ status, last_processed_block: "100", latest_known_block: "104", last_successful_run_at: null, updated_at: "2026-09-09T20:00:55.000Z" });
      await expect(verifierFor(row, { now: at("2026-09-09T20:01:00.000Z") }).verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });
    }
  });

  it("still applies the block-lag bound to a completed (IDLE) run", async () => {
    const now = at("2026-09-09T20:01:00.000Z");
    await expect(verifierFor(checkpoint({ latest_known_block: "130" }), { now }).verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });
    await expect(verifierFor(checkpoint({ latest_known_block: "125" }), { now }).verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });
    await expect(verifierFor(checkpoint({ latest_known_block: "124" }), { now }).verify({ wallet, requirements: [requirement] })).resolves.toMatchObject({ owns: true });
  });

  it("applies the staleness bound at its boundary for a completed run", async () => {
    const row = checkpoint({ last_processed_block: "100", latest_known_block: "112", last_successful_run_at: "2026-09-09T20:00:00.000Z" });
    await expect(verifierFor(row, { now: at("2026-09-09T20:01:59.000Z") }).verify({ wallet, requirements: [requirement] })).resolves.toMatchObject({ owns: true });
    await expect(verifierFor(row, { now: at("2026-09-09T20:02:01.000Z") }).verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });
  });

  it("fails closed for FAILED and REORGING checkpoints even when the last success is fresh", async () => {
    for (const status of ["FAILED", "REORGING", "", null]) {
      const row = checkpoint({ status, last_processed_block: "100", latest_known_block: "104" });
      await expect(verifierFor(row, { now: at("2026-09-09T20:00:30.000Z") }).verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });
    }
  });

  it("passes the gate on a rewound RUNNING row but still excludes reorg-pending snapshots", async () => {
    // A verified reorg moves last_processed_block backward and leaves the row RUNNING while it re-indexes.
    const row = checkpoint({ status: "RUNNING", last_processed_block: "60", latest_known_block: "104", last_successful_run_at: "2026-09-09T20:00:00.000Z" });
    const db = { query: vi.fn(async (sql) => (String(sql).includes("FROM indexer_checkpoints") ? { rows: [row] } : { rows: [] })) };
    const verifier = new IndexedOwnershipVerifier({ db, config, now: at("2026-09-09T20:00:30.000Z") });
    await expect(verifier.verify({ wallet, requirements: [requirement] })).resolves.toMatchObject({ owns: false, state: "CONFIRMED" });
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("synchronization_watermark <> 'REORG_PENDING'"), [43113, contract, wallet, ["7"], "1"]);
  });

  it("fails closed for a completed run whose progress columns are missing or not integers", async () => {
    const now = at("2026-09-09T20:01:00.000Z");
    for (const overrides of [{ last_processed_block: null }, { latest_known_block: null }, { last_processed_block: "abc" }, { latest_known_block: "1e400" }]) {
      await expect(verifierFor(checkpoint(overrides), { now }).verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "OWNERSHIP_INDEX_STALE" });
    }
  });
});
