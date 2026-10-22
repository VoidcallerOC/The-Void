import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService, deriveStudioApplicationReleaseId, deriveStudioReleaseKey } from "./studio-service.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const RELEASE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = `0x${"ab".repeat(32)}`;

function repository() {
  const repo = {
    saveContract: vi.fn(async (input) => ({ id: `${input.name}-id`, ...input })),
    saveReleaseContract: vi.fn(async (input) => ({ id: "binding-id", ...input })),
    getReleaseProvisioningRequest: vi.fn(async () => null),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}
function harness() {
  const release = { id: "release-1", artist_id: "artist-1", slug: "one", status: "DRAFT", release_metadata: { releaseKey: KEY } };
  const db = { query: vi.fn(async (sql) => {
    if (String(sql).includes("FROM releases r JOIN artist_owners")) return { rows: [release] };
    if (String(sql).includes("FROM factory_releases")) return { rows: [{ chain_id: 43113, factory_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", release_contract_address: RELEASE, release_key: KEY, artist_wallet: OWNER }] };
    return { rows: [] };
  }) };
  const repo = repository();
  const instance = new ArtistStudioService({ db, repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: OWNER }), logger: { error: vi.fn() } });
  return { instance, repo, db };
}

describe("Studio release contract binding", () => {
  it("refuses to bind arbitrary contracts without a durable V2 provisioning request", async () => {
    const { instance, repo } = harness();
    await expect(instance.bindReleaseContract({ request: { headers: {} }, releaseId: "release-1", input: { chainId: 43113, releaseContractAddress: RELEASE, releaseKey: KEY } })).rejects.toMatchObject({ code: "PROVISIONING_REQUEST_REQUIRED" });
    expect(repo.inTransaction).not.toHaveBeenCalled();
    expect(repo.saveReleaseContract).not.toHaveBeenCalled();
  });

  it("never attaches an existing clone to a new release: another release's key or an unindexed key is refused", async () => {
    const { instance, repo, db } = harness();
    const NEW_KEY = `0x${"11".repeat(32)}`;
    const OLD_CLONE = "0x8192cc13caec165afd802af691f952573bb3d817";
    const fresh = { id: "release-fresh", artist_id: "artist-1", slug: "fresh", status: "DRAFT", release_metadata: { releaseKey: NEW_KEY } };
    repo.getReleaseProvisioningRequest.mockResolvedValue({ release_key: NEW_KEY, artist_wallet: OWNER, factory_address: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8", chain_id: 43113, state: "PENDING" });
    // The indexer knows the old clone only under the old release's key; nothing is indexed under the new key.
    db.query.mockImplementation(async (sql, params = []) => {
      if (String(sql).includes("FROM releases r JOIN artist_owners")) return { rows: [fresh] };
      if (String(sql).includes("FROM factory_releases")) return { rows: params.some((value) => String(value).toLowerCase() === KEY) ? [{ chain_id: 43113, release_contract_address: OLD_CLONE, release_key: KEY, artist_wallet: OWNER }] : [] };
      return { rows: [] };
    });
    const request = { headers: {} };
    // Presenting the old clone's key for the new release does not match the new release's own key.
    await expect(instance.bindReleaseContract({ request, releaseId: "release-fresh", input: { chainId: 43113, releaseContractAddress: OLD_CLONE, releaseKey: KEY } })).rejects.toMatchObject({ status: 409, code: "RELEASE_PROVISIONING_MISMATCH" });
    // Presenting the new key with the old clone finds no matching deployment.
    await expect(instance.bindReleaseContract({ request, releaseId: "release-fresh", input: { chainId: 43113, releaseContractAddress: OLD_CLONE, releaseKey: NEW_KEY } })).rejects.toMatchObject({ status: 409, code: "RELEASE_DEPLOYMENT_NOT_INDEXED" });
    expect(repo.inTransaction).not.toHaveBeenCalled();
    expect(repo.saveReleaseContract).not.toHaveBeenCalled();
    // Status refresh for the new release binds nothing while its own key is not indexed.
    await expect(instance.releaseProvisioningStatus({ request, releaseId: "release-fresh" })).resolves.toMatchObject({ state: "PENDING", releaseId: "release-fresh" });
    expect(repo.saveReleaseContract).not.toHaveBeenCalled();
  });

  it("never binds, submits or refreshes a retired release, even when its clone exists on-chain", async () => {
    const { instance, repo, db } = harness();
    const archived = { id: "release-1", artist_id: "artist-1", slug: "one", status: "ARCHIVED", release_metadata: { releaseKey: KEY } };
    db.query.mockImplementation(async (sql) => (String(sql).includes("FROM releases r JOIN artist_owners") ? { rows: [archived] } : { rows: [] }));
    const request = { headers: {} };
    await expect(instance.bindReleaseContract({ request, releaseId: "release-1", input: { chainId: 43113, releaseContractAddress: RELEASE, releaseKey: KEY } })).rejects.toMatchObject({ status: 409, code: "RELEASE_ARCHIVED" });
    await expect(instance.releaseProvisioningStatus({ request, releaseId: "release-1" })).rejects.toMatchObject({ status: 409, code: "RELEASE_ARCHIVED" });
    await expect(instance.recordReleaseProvisioningSubmission({ request, releaseId: "release-1", input: { transactionHash: `0x${"cd".repeat(32)}` } })).rejects.toMatchObject({ status: 409, code: "RELEASE_ARCHIVED" });
    expect(repo.getReleaseProvisioningRequest).not.toHaveBeenCalled();
    expect(repo.saveReleaseContract).not.toHaveBeenCalled();
  });

  it("loads the release, dedicated sale, and provenance-anchor addresses from a verified binding", async () => {
    const { instance, db } = harness();
    db.query.mockResolvedValueOnce({ rows: [{ release_contract_id: "release-contract-id", release_contract_address: RELEASE, factory_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", primary_sale_address: "0xcccccccccccccccccccccccccccccccccccccc", provenance_anchor_address: "0xdddddddddddddddddddddddddddddddddddddd", release_key: KEY, chain_id: 43113, implementation_version: 2, status: "DEPLOYED" }] });
    await expect(instance.releaseContractBinding("release-1")).resolves.toMatchObject({ release_contract_address: RELEASE, factory_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", primary_sale_address: "0xcccccccccccccccccccccccccccccccccccccc", provenance_anchor_address: "0xdddddddddddddddddddddddddddddddddddddd" });
    expect(db.query.mock.calls[0][0]).toContain("sale_contract.address AS primary_sale_address");
    expect(db.query.mock.calls[0][0]).toContain("anchor_contract.address AS provenance_anchor_address");
  });

  it("derives a deterministic release key scoped to chain, canonical artist, and application release id", () => {
    const factoryAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const first = deriveStudioReleaseKey({ releaseId: "release-1", artistWallet: OWNER, factoryAddress });
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveStudioReleaseKey({ releaseId: "release-1", artistWallet: OWNER, factoryAddress })).toBe(first);
    expect(deriveStudioReleaseKey({ releaseId: "release-2", artistWallet: OWNER, factoryAddress })).not.toBe(first);
    expect(deriveStudioReleaseKey({ releaseId: "release-1", artistWallet: "0x2222222222222222222222222222222222222222", factoryAddress })).not.toBe(first);
    expect(deriveStudioReleaseKey({ releaseId: "release-1", artistWallet: OWNER, factoryAddress, chainId: 43114 })).not.toBe(first);
  });
});

describe("provisioning across factory deployments", () => {
  const OLD_FACTORY = "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505";
  const NEW_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
  const request = { headers: {} };
  function provisioningHarness({ existingRequest = null, releaseKey, artistAuthority = {}, releaseMetadata = {}, metadataStorage = { write: vi.fn(async () => ({ uri: "ipfs://collection-metadata-cid" })) } } = {}) {
    const release = { id: "release-p", artist_id: "artist-1", slug: "p", title: "Prepared Release", status: "DRAFT", release_metadata: { applicationReleaseId: deriveStudioApplicationReleaseId("release-p"), ...(releaseKey ? { releaseKey } : {}), ...releaseMetadata } };
    const authority = { id: "artist-1", status: "ACTIVE", wallet_authorized: true, verification_decision: "VERIFIED", application_verified: true, contract_verified: false, ...artistAuthority };
    const db = { query: vi.fn(async (sql) => (String(sql).includes("FROM releases r JOIN artist_owners") ? { rows: [release] } : String(sql).includes("FROM artists a WHERE a.id=$1") ? { rows: [authority] } : String(sql).startsWith("UPDATE releases SET release_metadata") ? { rows: [{ id: release.id }] } : { rows: [] })) };
    const repo = repository();
    repo.getReleaseProvisioningRequest = vi.fn(async () => existingRequest);
    repo.createReleaseProvisioningRequest = vi.fn(async (input) => ({ request_id: "req-1", state: "PREPARED", ...input }));
    const instance = new ArtistStudioService({ db, repository: repo, metadataStorage, authenticator: vi.fn().mockResolvedValue({ wallet: OWNER }), logger: { error: vi.fn() } });
    return { instance, repo, db, metadataStorage };
  }

  it("prepares a new release on the active album-capable factory", async () => {
    const { instance, repo } = provisioningHarness();
    const prepared = await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(prepared.factoryAddress).toBe(NEW_FACTORY);
    expect(prepared.releaseKey).toBe(deriveStudioReleaseKey({ releaseId: "release-p", artistWallet: OWNER, factoryAddress: NEW_FACTORY }));
    expect(repo.createReleaseProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ factoryAddress: NEW_FACTORY }));
  });

  it("generates a non-empty collection contract URI through the metadata pipeline and carries it into the authorized createRelease parameters", async () => {
    const { instance, repo, metadataStorage } = provisioningHarness();
    const prepared = await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(prepared.contractURI).toBe("ipfs://collection-metadata-cid");
    expect(metadataStorage.write).toHaveBeenCalledOnce();
    expect(metadataStorage.write).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ name: "Prepared Release" }) }));
    expect(repo.createReleaseProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ expectedParameters: expect.objectContaining({ contractURI: "ipfs://collection-metadata-cid" }) }));
  });

  it("reuses an already-persisted contract URI without re-uploading, keeping a retry's authorization digest stable", async () => {
    const { instance, repo, metadataStorage } = provisioningHarness({ releaseMetadata: { contractURI: "ipfs://already-pinned" } });
    const prepared = await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(prepared.contractURI).toBe("ipfs://already-pinned");
    expect(metadataStorage.write).not.toHaveBeenCalled();
    expect(repo.createReleaseProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ expectedParameters: expect.objectContaining({ contractURI: "ipfs://already-pinned" }) }));
  });

  it("fails closed, never authorizing createRelease with an empty contract URI, when metadata storage is unavailable", async () => {
    const { instance, repo } = provisioningHarness({ metadataStorage: null });
    await expect(instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).rejects.toMatchObject({ status: 503, code: "METADATA_STORAGE_UNAVAILABLE" });
    expect(repo.createReleaseProvisioningRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the metadata upload fails, never binding a placeholder or fabricated URI", async () => {
    const metadataStorage = { write: vi.fn(async () => { throw Object.assign(new Error("provider rejected"), { status: 503, code: "METADATA_STORAGE_UNAVAILABLE" }); }) };
    const { instance, repo } = provisioningHarness({ metadataStorage });
    await expect(instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).rejects.toMatchObject({ code: "METADATA_STORAGE_UNAVAILABLE" });
    expect(metadataStorage.write).toHaveBeenCalledOnce();
    expect(repo.createReleaseProvisioningRequest).not.toHaveBeenCalled();
  });

  it("refuses to prepare the createRelease transaction for an unverified artist, before any gas is spent", async () => {
    const { instance, repo, db } = provisioningHarness({ artistAuthority: { application_verified: false, contract_verified: false, verification_decision: null } });
    await expect(instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).rejects.toMatchObject({ status: 403, code: "ARTIST_NOT_VERIFIED" });
    expect(repo.createReleaseProvisioningRequest).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE releases SET release_metadata"))).toBe(false);
  });

  it("uses the artist's chosen contract symbol instead of the title-derived one", async () => {
    const { instance, repo } = provisioningHarness({ releaseMetadata: { contractSymbol: "FNF" } });
    const prepared = await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(prepared.symbol).toBe("FNF");
    expect(prepared.name).toBe("Prepared Release");
    expect(repo.createReleaseProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ expectedParameters: expect.objectContaining({ symbol: "FNF", name: "Prepared Release" }) }));
  });

  it("falls back to the title-derived symbol when none is chosen", async () => {
    const { instance } = provisioningHarness();
    expect((await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).symbol).toBe("PREPAREDREL");
  });

  it("rejects an invalid stored contract symbol before any transaction is prepared", async () => {
    const { instance, repo } = provisioningHarness({ releaseMetadata: { contractSymbol: "NOT A SYMBOL!" } });
    await expect(instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).rejects.toMatchObject({ status: 400, code: "CONTRACT_SYMBOL_INVALID" });
    expect(repo.createReleaseProvisioningRequest).not.toHaveBeenCalled();
  });

  it("keeps a release already provisioned on the historical factory on that factory and key", async () => {
    const oldKey = deriveStudioReleaseKey({ releaseId: "release-p", artistWallet: OWNER, factoryAddress: OLD_FACTORY });
    const { instance, repo } = provisioningHarness({ releaseKey: oldKey, existingRequest: { request_id: "req-old", state: "CONFIRMED", factory_address: OLD_FACTORY.toLowerCase(), release_key: oldKey, artist_wallet: OWNER } });
    const prepared = await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(prepared).toMatchObject({ factoryAddress: OLD_FACTORY, releaseKey: oldKey });
    expect(repo.createReleaseProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ factoryAddress: OLD_FACTORY, releaseKey: oldKey }));
  });

  it("reads provisioning status from the recorded factory's deployments", async () => {
    const oldKey = deriveStudioReleaseKey({ releaseId: "release-p", artistWallet: OWNER, factoryAddress: OLD_FACTORY });
    const { instance, db } = provisioningHarness({ releaseKey: oldKey, existingRequest: { request_id: "req-old", state: "CONFIRMED", factory_address: OLD_FACTORY.toLowerCase(), release_key: oldKey, artist_wallet: OWNER } });
    await expect(instance.releaseProvisioningStatus({ request, releaseId: "release-p" })).resolves.toMatchObject({ state: "CONFIRMED" });
    const lookup = db.query.mock.calls.find(([sql]) => String(sql).includes("FROM factory_releases"));
    expect(lookup[1][1]).toBe(OLD_FACTORY);
  });

  it("refuses a provisioning request recorded on a factory that is not a known deployment", async () => {
    const { instance } = provisioningHarness({ existingRequest: { request_id: "req-x", state: "PREPARED", factory_address: "0x8291a4f1936c1c5c6d8917b0966c80757cd5c265", release_key: KEY, artist_wallet: OWNER } });
    await expect(instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).rejects.toMatchObject({ status: 409, code: "PROVISIONING_FACTORY_UNKNOWN" });
  });
});

