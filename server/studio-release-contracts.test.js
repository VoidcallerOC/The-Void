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
  function provisioningHarness({ existingRequest = null, releaseKey } = {}) {
    const release = { id: "release-p", artist_id: "artist-1", slug: "p", title: "Prepared Release", status: "DRAFT", release_metadata: { applicationReleaseId: deriveStudioApplicationReleaseId("release-p"), ...(releaseKey ? { releaseKey } : {}) } };
    const db = { query: vi.fn(async (sql) => (String(sql).includes("FROM releases r JOIN artist_owners") ? { rows: [release] } : String(sql).startsWith("UPDATE releases SET release_metadata") ? { rows: [{ id: release.id }] } : { rows: [] })) };
    const repo = repository();
    repo.getReleaseProvisioningRequest = vi.fn(async () => existingRequest);
    repo.createReleaseProvisioningRequest = vi.fn(async (input) => ({ request_id: "req-1", state: "PREPARED", ...input }));
    const instance = new ArtistStudioService({ db, repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: OWNER }), logger: { error: vi.fn() } });
    return { instance, repo, db };
  }

  it("prepares a new release on the active album-capable factory", async () => {
    const { instance, repo } = provisioningHarness();
    const prepared = await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(prepared.factoryAddress).toBe(NEW_FACTORY);
    expect(prepared.releaseKey).toBe(deriveStudioReleaseKey({ releaseId: "release-p", artistWallet: OWNER, factoryAddress: NEW_FACTORY }));
    expect(repo.createReleaseProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ factoryAddress: NEW_FACTORY }));
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

