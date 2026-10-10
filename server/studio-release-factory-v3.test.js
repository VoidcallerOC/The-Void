import { describe, expect, it, vi } from "vitest";

// The committed manifest is not switched to Factory V3 (that needs owner authorization). This mocks a
// manifest where V3 is the active factory and V2 is history, which is the planned post-deploy shape.
const V3_FACTORY = "0x7777777777777777777777777777777777777777";
const V2_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
vi.mock("../config/release-network.js", async (importOriginal) => {
  const original = await importOriginal();
  const active = { ...original.FUJI_RELEASE_PER_CONTRACT_V2, factoryAddress: V3_FACTORY, releaseVersion: 3 };
  const deployments = [
    { factoryAddress: V3_FACTORY, releaseVersion: 3, albumCapable: true, active: true, chainId: 43113, provenanceAtCreation: true },
    { factoryAddress: V2_FACTORY, releaseVersion: 2, albumCapable: true, active: false, chainId: 43113, provenanceAtCreation: false },
  ];
  return { ...original, FUJI_RELEASE_PER_CONTRACT_V2: active, FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS: deployments, releaseDeploymentForFactory: (address) => deployments.find((item) => item.factoryAddress.toLowerCase() === String(address || "").toLowerCase()) || null };
});

const { ArtistStudioService } = await import("./studio-service.js");

const OWNER = "0x1111111111111111111111111111111111111111";
const RELEASE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ANCHOR = "0xcccccccccccccccccccccccccccccccccccccccc";
const KEY = `0x${"ab".repeat(32)}`;
const TX = `0x${"de".repeat(32)}`;

function harness({ factory = V3_FACTORY, version = 3, anchor = RELEASE } = {}) {
  const release = { id: "release-1", artist_id: "artist-1", slug: "one", status: "DRAFT", release_metadata: { releaseKey: KEY } };
  const indexed = { chain_id: 43113, factory_address: factory.toLowerCase(), release_contract_address: RELEASE, release_key: KEY, artist_wallet: OWNER, primary_sale_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", provenance_anchor_address: anchor, implementation_address: "0xdddddddddddddddddddddddddddddddddddddddd", implementation_version: version, transaction_hash: TX, deployment_block_number: 90, factory_index: 0 };
  const db = { query: vi.fn(async (sql) => {
    if (String(sql).includes("FROM releases r JOIN artist_owners")) return { rows: [release] };
    if (String(sql).includes("FROM factory_releases")) return { rows: [indexed] };
    return { rows: [] };
  }) };
  const repo = {
    saveContract: vi.fn(async (input) => ({ id: `${input.name}-id`, ...input })),
    saveReleaseContract: vi.fn(async (input) => ({ id: "binding-id", ...input })),
    getReleaseProvisioningRequest: vi.fn(async () => ({ request_id: "req-1", release_key: KEY, artist_wallet: OWNER, factory_address: factory.toLowerCase(), transaction_hash: TX })),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  const instance = new ArtistStudioService({ db, repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: OWNER }), logger: { error: vi.fn() } });
  return { instance, repo };
}

const bind = (instance) => instance.bindReleaseContract({ request: { headers: {} }, releaseId: "release-1", input: { chainId: 43113, releaseContractAddress: RELEASE, releaseKey: KEY } });

describe("binding Factory V3 releases alongside Factory V2 history", () => {
  it("binds a V3 clone as its own provenance anchor", async () => {
    const { instance, repo } = harness();
    await expect(bind(instance)).resolves.toMatchObject({ releaseContractAddress: RELEASE, provenanceAnchorAddress: RELEASE, implementationVersion: 3 });
    expect(repo.saveContract.mock.calls.map(([input]) => input.name)).toEqual(["VoidRelease1155V5", "VoidReleaseFactoryV3", "VoidPrimarySale"]);
    expect(repo.saveReleaseContract).toHaveBeenCalledWith(expect.objectContaining({ releaseContractId: "VoidRelease1155V5-id", provenanceAnchorContractId: "VoidRelease1155V5-id", implementationVersion: 3 }));
  });

  it("refuses a V3 event whose anchor is a separate contract, or a version the factory does not emit", async () => {
    await expect(bind(harness({ anchor: ANCHOR }).instance)).rejects.toMatchObject({ code: "RELEASE_DEPLOYMENT_EVENT_MISMATCH" });
    await expect(bind(harness({ version: 2 }).instance)).rejects.toMatchObject({ code: "RELEASE_DEPLOYMENT_EVENT_MISMATCH" });
  });

  it("keeps binding releases recorded on the historical V2 factory with their separate anchor", async () => {
    const { instance, repo } = harness({ factory: V2_FACTORY, version: 2, anchor: ANCHOR });
    await expect(bind(instance)).resolves.toMatchObject({ provenanceAnchorAddress: ANCHOR, implementationVersion: 2 });
    expect(repo.saveContract.mock.calls.map(([input]) => input.name)).toEqual(["VoidRelease1155V4", "VoidReleaseFactoryV2", "VoidPrimarySale", "VoidProvenanceAnchor"]);
    await expect(bind(harness({ factory: V2_FACTORY, version: 2, anchor: RELEASE }).instance)).rejects.toMatchObject({ code: "RELEASE_DEPLOYMENT_EVENT_MISMATCH" });
  });
});
