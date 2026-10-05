import { describe, expect, it, vi } from "vitest";
import { PersistenceRepository } from "./repositories.js";

const ARTIST = "0xa11ce00000000000000000000000000000000004";
const IMPLEMENTATION = "0x1111111111111111111111111111111111111111";
const KEY_A = `0x${"aa".repeat(32)}`;
const KEY_B = `0x${"bb".repeat(32)}`;

function payload({ releaseId, releaseContractId, releaseKey }) {
  return {
    releaseId,
    chainId: 43113,
    releaseContractId,
    factoryContractId: "factory-id",
    primarySaleContractId: `sale-${releaseId}`,
    provenanceAnchorContractId: `anchor-${releaseId}`,
    releaseKey,
    artistWallet: ARTIST,
    implementationAddress: IMPLEMENTATION,
    implementationVersion: 1,
    deploymentTxHash: `0x${"11".repeat(32)}`,
    deploymentBlockNumber: 123,
    creationLogIndex: 2,
    status: "VERIFIED",
  };
}

describe("release contract persistence", () => {
  it("persists separate immutable bindings for two releases by the same artist", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "release-contract-row" }] }) };
    const repository = new PersistenceRepository(db);
    await repository.saveReleaseContract(payload({ releaseId: "release-a", releaseContractId: "contract-a", releaseKey: KEY_A }));
    await repository.saveReleaseContract(payload({ releaseId: "release-b", releaseContractId: "contract-b", releaseKey: KEY_B }));
    expect(db.query).toHaveBeenCalledTimes(2);
    const firstValues = db.query.mock.calls[0][1];
    const secondValues = db.query.mock.calls[1][1];
    expect(firstValues[0]).toBe("release-a");
    expect(secondValues[0]).toBe("release-b");
    expect(firstValues[2]).toBe("contract-a");
    expect(secondValues[2]).toBe("contract-b");
    expect(firstValues[6]).toBe(KEY_A);
    expect(secondValues[6]).toBe(KEY_B);
  });

  it("writes a conflict-protected immutable upsert and can resolve the canonical tuple", async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "release-contract-row" }] })
      .mockResolvedValueOnce({ rows: [{ release_id: "release-a", chain_id: 43113, release_contract_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", primary_sale_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] }) };
    const repository = new PersistenceRepository(db);
    await repository.saveReleaseContract(payload({ releaseId: "release-a", releaseContractId: "contract-a", releaseKey: KEY_A }));
    const resolved = await repository.getReleaseContract({ releaseId: "release-a", chainId: 43113 });
    expect(db.query.mock.calls[0][0]).toContain("release_contracts.release_contract_id=EXCLUDED.release_contract_id");
    expect(db.query.mock.calls[0][0]).toContain("release_contracts.release_key=EXCLUDED.release_key");
    expect(resolved).toMatchObject({ release_id: "release-a", release_contract_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  });
});
