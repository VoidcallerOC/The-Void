import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService, deriveStudioApplicationReleaseId, deriveStudioReleaseKey } from "./studio-service.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const request = { requestId: "req", headers: {} };

function repository() {
  const repo = {
    saveRelease: vi.fn(async (input) => ({ id: input.id, artist_id: input.artistId, title: input.title, status: input.status, release_metadata: input.metadata })),
    getReleaseProvisioningRequest: vi.fn(async () => null),
    createReleaseProvisioningRequest: vi.fn(async (input) => ({ request_id: "req-1", state: "PENDING", ...input })),
    refreshReleaseProvisioningRequest: vi.fn(async (input) => ({ request_id: "req-1", state: "PENDING", ...input })),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}

// prepareReleaseProvisioning harness: an undeployed draft, optionally with an existing request.
function prepareHarness({ symbol, existingRequest = null, deployed = false } = {}) {
  const applicationReleaseId = deriveStudioApplicationReleaseId("release-p");
  const releaseKey = deriveStudioReleaseKey({ releaseId: "release-p", applicationReleaseId, artistWallet: OWNER, factoryAddress: FACTORY });
  const release = { id: "release-p", artist_id: "artist-1", slug: "p", title: "Forgive & Forget", status: "DRAFT", release_metadata: { applicationReleaseId, releaseKey, contractURI: "ipfs://pinned", ...(symbol ? { contractSymbol: symbol } : {}) } };
  const authority = { id: "artist-1", status: "ACTIVE", wallet_authorized: true, verification_decision: "VERIFIED", application_verified: true, contract_verified: false };
  const db = { query: vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes("FROM releases r JOIN artist_owners")) return { rows: [release] };
    if (text.includes("FROM artists a WHERE a.id=$1")) return { rows: [authority] };
    if (text.includes("FROM factory_releases")) return { rows: deployed ? [{ one: 1 }] : [] };
    return { rows: [] };
  }) };
  const repo = repository();
  repo.getReleaseProvisioningRequest = vi.fn(async () => existingRequest);
  const instance = new ArtistStudioService({ db, repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: OWNER }), logger: { error: vi.fn() } });
  return { instance, repo, releaseKey };
}

describe("on-chain tag: loading and preparing an existing undeployed draft", () => {
  it("prepares with the draft's current symbol (title-derived when none was chosen)", async () => {
    const { instance } = prepareHarness();
    expect(await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).toMatchObject({ name: "Forgive & Forget", symbol: "FORGIVEFORG" });
  });

  it("re-preparing after a symbol change refreshes a never-submitted request with the new parameters and records why", async () => {
    const first = prepareHarness();
    const original = await first.instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    const stale = { request_id: "req-1", state: "PENDING", transaction_hash: null, factory_address: FACTORY.toLowerCase(), release_key: first.releaseKey, artist_wallet: OWNER, authorization_digest: original.authorizationDigest, expected_parameters: { symbol: "FORGIVEFORG" } };
    const { instance, repo } = prepareHarness({ symbol: "FNF", existingRequest: stale });
    const prepared = await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(prepared.symbol).toBe("FNF");
    expect(prepared.authorizationDigest).not.toBe(original.authorizationDigest);
    expect(repo.refreshReleaseProvisioningRequest).toHaveBeenCalledWith(expect.objectContaining({ releaseId: "release-p", authorizationDigest: prepared.authorizationDigest, expectedParameters: expect.objectContaining({ symbol: "FNF" }) }));
    expect(repo.createReleaseProvisioningRequest).not.toHaveBeenCalled();
    expect(repo.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_RELEASE_PROVISIONING_REPREPARED", payload: expect.objectContaining({ previousDigest: original.authorizationDigest, symbol: "FNF", previousSymbol: "FORGIVEFORG" }) }));
  });

  it("an unchanged preparation stays idempotent and never touches the request", async () => {
    const first = prepareHarness();
    const original = await first.instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    const same = { request_id: "req-1", state: "PENDING", transaction_hash: null, factory_address: FACTORY.toLowerCase(), release_key: first.releaseKey, artist_wallet: OWNER, authorization_digest: original.authorizationDigest, expected_parameters: {} };
    const { instance, repo } = prepareHarness({ existingRequest: same });
    await instance.prepareReleaseProvisioning({ request, releaseId: "release-p" });
    expect(repo.createReleaseProvisioningRequest).toHaveBeenCalledOnce();
    expect(repo.refreshReleaseProvisioningRequest).not.toHaveBeenCalled();
  });
});

describe("on-chain tag: stale parameters can never be deployed", () => {
  const changed = (overrides) => ({ request_id: "req-1", state: "PENDING", transaction_hash: null, factory_address: FACTORY.toLowerCase(), release_key: "set-below", artist_wallet: OWNER, authorization_digest: `0x${"11".repeat(32)}`, expected_parameters: { symbol: "OLD" }, ...overrides });

  for (const [label, overrides] of [
    ["a request with a recorded transaction", { transaction_hash: `0x${"22".repeat(32)}` }],
    ["a SUBMITTED request", { state: "SUBMITTED" }],
    ["a RECONCILING request", { state: "RECONCILING" }],
    ["a CONFIRMED request", { state: "CONFIRMED" }],
  ]) {
    it(`refuses to re-prepare ${label}`, async () => {
      const { instance, repo, releaseKey } = prepareHarness({ symbol: "FNF", existingRequest: changed({ ...overrides, release_key: undefined }) });
      repo.getReleaseProvisioningRequest.mockResolvedValue(changed({ ...overrides, release_key: releaseKey }));
      await expect(instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).rejects.toMatchObject({ status: 409, code: "RELEASE_PROVISIONING_LOCKED" });
      expect(repo.refreshReleaseProvisioningRequest).not.toHaveBeenCalled();
      expect(repo.createReleaseProvisioningRequest).not.toHaveBeenCalled();
    });
  }

  it("refuses to re-prepare when the release key is already deployed, even if the request never recorded a transaction", async () => {
    const { instance, repo, releaseKey } = prepareHarness({ symbol: "FNF", deployed: true });
    repo.getReleaseProvisioningRequest.mockResolvedValue(changed({ release_key: releaseKey }));
    await expect(instance.prepareReleaseProvisioning({ request, releaseId: "release-p" })).rejects.toMatchObject({ code: "RELEASE_PROVISIONING_LOCKED" });
    expect(repo.refreshReleaseProvisioningRequest).not.toHaveBeenCalled();
  });
});

describe("on-chain tag: editing and saving against the existing draft", () => {
  function updateHarness({ symbol, status = "DRAFT", bound = false, requests = [] } = {}) {
    const release = { id: "release-1", artist_id: "artist-1", slug: "forgive-forget", title: "Forgive & Forget", description: null, status, release_metadata: { releaseType: "SINGLE", ...(symbol ? { contractSymbol: symbol } : {}) }, published_at: null };
    const db = { query: vi.fn(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM releases r JOIN artist_owners")) return { rows: [release] };
      if (text.includes("FROM release_contracts")) return { rows: bound ? [{ one: 1 }] : [] };
      if (text.includes("FROM release_provisioning_requests")) return { rows: requests };
      return { rows: [] };
    }) };
    const repo = repository();
    const instance = new ArtistStudioService({ db, repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: OWNER }), logger: { error: vi.fn() } });
    return { instance, repo };
  }

  it("saves a new symbol on the same release id and slug, normalised, without creating a release", async () => {
    const { instance, repo } = updateHarness();
    await instance.updateRelease({ request, releaseId: "release-1", input: { symbol: " fnf " } });
    expect(repo.saveRelease).toHaveBeenCalledOnce();
    expect(repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ id: "release-1", slug: "forgive-forget", metadata: expect.objectContaining({ contractSymbol: "FNF", releaseType: "SINGLE" }) }));
  });

  it("validates with the app's rule: 1 to 11 letters or digits", async () => {
    const { instance, repo } = updateHarness();
    for (const bad of ["TWELVECHARS1", "NOT A SYMBOL", "FNF-1", "ÅBC"]) {
      await expect(instance.updateRelease({ request, releaseId: "release-1", input: { symbol: bad } })).rejects.toMatchObject({ status: 400, code: "CONTRACT_SYMBOL_INVALID" });
    }
    expect(repo.saveRelease).not.toHaveBeenCalled();
    await expect(instance.updateRelease({ request, releaseId: "release-1", input: { symbol: "ABCDEFGHIJK" } })).resolves.toBeTruthy();
  });

  it("allows the edit while only a never-submitted request exists", async () => {
    const { instance, repo } = updateHarness({ symbol: "OLD", requests: [{ state: "PENDING", transaction_hash: null }] });
    await instance.updateRelease({ request, releaseId: "release-1", input: { symbol: "NEW" } });
    expect(repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ contractSymbol: "NEW" }) }));
  });

  it("an unchanged symbol is a no-op for the lock check", async () => {
    const { instance, repo } = updateHarness({ symbol: "SAME", bound: true });
    await instance.updateRelease({ request, releaseId: "release-1", input: { symbol: "same" } });
    expect(repo.saveRelease).toHaveBeenCalledOnce();
  });

  it("locks the symbol only once the deployment is submitted or created on-chain", async () => {
    const cases = [
      { bound: true },
      { requests: [{ state: "CONFIRMED", transaction_hash: `0x${"aa".repeat(32)}` }] },
      { requests: [{ state: "SUBMITTED", transaction_hash: null }] },
      { requests: [{ state: "RECONCILING", transaction_hash: null }] },
      { requests: [{ state: "PENDING", transaction_hash: `0x${"bb".repeat(32)}` }] },
      { status: "PUBLISHED" },
    ];
    for (const setup of cases) {
      const { instance, repo } = updateHarness({ symbol: "OLD", ...setup });
      await expect(instance.updateRelease({ request, releaseId: "release-1", input: { symbol: "NEW" } })).rejects.toMatchObject({ status: 409, code: "CONTRACT_SYMBOL_LOCKED" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
    }
  });
});
