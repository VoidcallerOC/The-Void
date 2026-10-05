import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService } from "./studio-service.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const RELEASE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FACTORY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SALE = "0xcccccccccccccccccccccccccccccccccccccccc";
const ANCHOR = "0xdddddddddddddddddddddddddddddddddddddddd";
const IMPLEMENTATION = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const KEY = `0x${"ab".repeat(32)}`;

function repository() {
  const repo = {
    saveContract: vi.fn(async (input) => ({ id: `${input.name}-id`, ...input })),
    saveReleaseContract: vi.fn(async (input) => ({ id: "binding-id", ...input })),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}
function harness({ indexed = true } = {}) {
  const release = { id: "release-1", artist_id: "artist-1", slug: "one", status: "DRAFT" };
  const deployment = { chain_id: 43113, factory_address: FACTORY, release_contract_address: RELEASE, release_key: KEY, artist_wallet: OWNER, primary_sale_address: SALE, provenance_anchor_address: ANCHOR, implementation_address: IMPLEMENTATION, implementation_version: 1, factory_index: "2", deployment_block_number: 123, transaction_hash: `0x${"12".repeat(32)}` };
  const db = { query: vi.fn(async (sql) => {
    if (String(sql).includes("FROM releases r JOIN artist_owners")) return { rows: [release] };
    if (String(sql).includes("FROM factory_releases")) return { rows: indexed ? [deployment] : [] };
    return { rows: [] };
  }) };
  const repo = repository();
  const instance = new ArtistStudioService({ db, repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: OWNER }), logger: { error: vi.fn() } });
  return { instance, repo, db, deployment };
}

describe("Studio release contract binding", () => {
  it("persists the exact factory-indexed contract, sale and provenance tuple", async () => {
    const { instance, repo } = harness();
    const result = await instance.bindReleaseContract({ request: { requestId: "request-1", headers: {} }, releaseId: "release-1", input: { chainId: 43113, releaseContractAddress: RELEASE, releaseKey: KEY } });
    expect(result).toMatchObject({ releaseContractAddress: RELEASE, primarySaleAddress: SALE, provenanceAnchorAddress: ANCHOR, chainId: 43113, status: "DEPLOYED" });
    expect(repo.saveContract).toHaveBeenCalledTimes(4);
    expect(repo.saveReleaseContract).toHaveBeenCalledWith(expect.objectContaining({ releaseId: "release-1", releaseKey: KEY, releaseContractId: "VoidRelease1155V4-id", primarySaleContractId: "VoidPrimarySale-id", provenanceAnchorContractId: "VoidProvenanceAnchor-id", implementationAddress: IMPLEMENTATION, implementationVersion: 1, status: "DEPLOYED" }));
    expect(repo.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_RELEASE_CONTRACT_BOUND", actorWallet: OWNER }));
  });

  it("refuses browser-supplied contracts that were not discovered from the release factory", async () => {
    const { instance, repo } = harness({ indexed: false });
    await expect(instance.bindReleaseContract({ request: { headers: {} }, releaseId: "release-1", input: { chainId: 43113, releaseContractAddress: RELEASE, releaseKey: KEY } })).rejects.toMatchObject({ code: "RELEASE_DEPLOYMENT_NOT_INDEXED" });
    expect(repo.inTransaction).not.toHaveBeenCalled();
  });
});
