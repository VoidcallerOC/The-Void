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

  it("rejects unsupported or malformed experience requirements", async () => {
    const verifier = new IndexedOwnershipVerifier({ db: { query: vi.fn() }, config });
    await expect(verifier.verify({ wallet, requirements: [{ type: "wallet-claim", contract, tokenIds: ["7"] }] })).rejects.toMatchObject({ code: "EXPERIENCE_REQUIREMENT_UNSUPPORTED" });
    await expect(verifier.verify({ wallet, requirements: [{ type: "erc1155-balance", contract: "bad", tokenIds: [] }] })).rejects.toMatchObject({ code: "EXPERIENCE_REQUIREMENT_INVALID" });
  });
});
