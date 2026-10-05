import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService, deriveStudioReleaseKey } from "./studio-service.js";

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
