import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { loadMediaConfig } from "./config.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { PrivateMediaStorage } from "./media-storage.js";
import { LEGACY_CHAIN_ID, LEGACY_CONTRACT, LEGACY_IPFS_MEDIA } from "../src/lib/legacy-genesis.js";

const wallet = "0x1111111111111111111111111111111111111111";
const otherWallet = "0x2222222222222222222222222222222222222222";
const mediaConfig = { driver: "filesystem", privateRoot: "/private-media", grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 1024 * 1024, auditHashSecret: "test-audit-secret" };
const assetRow = { id: "asset-1", artist_id: "artist-1", storage_key: "voidcaller-full-ep/ep1-01-the-hollow.mp3" };
const experience = { id: "voidcaller-full-ep", artist_id: "artist-1", status: "PUBLISHED", requirements: [{ type: "erc1155-balance", contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenIds: ["7"], minAmount: "1" }], media_config: { protected: true, protectedMedia: [{ mediaType: "AUDIO", assetId: "asset-1", contentType: "audio/mpeg" }] } };

function request({ headers = {}, requestId = "request-1" } = {}) { return { headers, requestId, ip: "127.0.0.1" }; }

function harness({ identity = { wallet }, ownership = { owns: true, state: "FINALIZED", chainId: 43114, watermark: "100:0" }, grant = null, storage = null } = {}) {
  const repository = {
    inTransaction: vi.fn(async (operation) => operation(repository)),
    createGrant: vi.fn(async (input) => ({ grant_id: input.grantId, expires_at: input.expiresAt.toISOString(), ...input })),
    recordMediaAuthorization: vi.fn().mockResolvedValue({ id: "audit-row" }),
    appendAuditEvent: vi.fn().mockResolvedValue({ id: "event-row" }),
    getMediaGrant: vi.fn().mockResolvedValue(grant),
    revokeMediaGrant: vi.fn().mockResolvedValue({ grant_id: "grant-1", experience_id: experience.id, media_type: "AUDIO", revoked_at: new Date().toISOString() }),
  };
  const db = { query: vi.fn(async (sql) => (String(sql).includes("media_assets") ? { rows: [assetRow] } : { rows: [experience] })) };
  const gateway = new ProtectedMediaGateway({ db, repository, authenticator: async () => identity, ownershipVerifier: vi.fn().mockResolvedValue(ownership), storage: storage || { open: vi.fn().mockResolvedValue({ type: "redirect", url: "https://media.example/protected?sig=opaque" }) }, mediaConfig });
  return { gateway, db, repository };
}

function responseDouble() { return { headers: null, status: null, body: "", writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body = "") { this.body = body; } }; }
function requestDouble({ method = "GET", url = "/api/health", body = "", headers = {} } = {}) { return { method, url, headers, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } }; }

describe("protected media gateway", () => {
  it("rejects an unauthenticated wallet before issuing a grant", async () => {
    const { gateway } = harness({ identity: null });
    await expect(gateway.issueGrant({ request: request(), input: { wallet, experienceId: experience.id, mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an authenticated non-owner and records a denial", async () => {
    const { gateway, repository } = harness({ ownership: { owns: false, state: "PENDING" } });
    await expect(gateway.issueGrant({ request: request(), input: { wallet, experienceId: experience.id, mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "EXPERIENCE_ENTITLEMENT_REQUIRED" });
    expect(repository.createGrant).not.toHaveBeenCalled();
    expect(repository.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "MEDIA_ACCESS_DENIED", actorWallet: wallet }));
  });

  it("does not sign a foreign or unknown storage key even when ownership verification passes", async () => {
    for (const rows of [[{ id: "asset-9", artist_id: "other-artist", storage_key: "bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234" }], []]) {
      const { gateway, repository, db } = harness();
      db.query.mockImplementation(async (sql) => (String(sql).includes("media_assets") ? { rows } : { rows: [experience] }));
      await expect(gateway.issueGrant({ request: request(), input: { wallet, experienceId: experience.id, mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_OWNED" });
      expect(repository.createGrant).not.toHaveBeenCalled();
    }
  });

  it("issues a wallet-bound short-lived opaque grant only to an authenticated confirmed owner", async () => {
    const { gateway, repository } = harness();
    const result = await gateway.issueGrant({ request: request({ headers: { "user-agent": "test" } }), input: { wallet, experienceId: experience.id, mediaType: "AUDIO" } });
    expect(result).toMatchObject({ state: "CONFIRMED", accessUrl: expect.stringMatching(/^\/api\/media\//) });
    expect(result.accessUrl).not.toContain("ep1-01-the-hollow");
    expect(repository.createGrant).toHaveBeenCalledWith(expect.objectContaining({ wallet, experienceId: experience.id, mediaType: "AUDIO", metadata: expect.objectContaining({ storageKey: "voidcaller-full-ep/ep1-01-the-hollow.mp3" }) }));
    expect(repository.recordMediaAuthorization).toHaveBeenCalledWith(expect.objectContaining({ action: "GRANT_ISSUED", ipHash: expect.any(String), userAgentHash: expect.any(String) }));
  });

  it("allows an active opaque grant and records protected media access", async () => {
    const activeGrant = { grant_id: "grant-1", wallet_address: wallet, experience_id: experience.id, media_type: "AUDIO", expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null, metadata: { storageKey: "voidcaller-full-ep/ep1-01-the-hollow.mp3", contentType: "audio/mpeg" } };
    const storage = { open: vi.fn().mockResolvedValue({ type: "redirect", url: "https://media.example/protected?sig=opaque" }) };
    const { gateway, repository } = harness({ grant: activeGrant, storage });
    await expect(gateway.openMedia({ request: request(), grantId: "grant-1" })).resolves.toMatchObject({ type: "redirect" });
    expect(storage.open).toHaveBeenCalledWith({ storageKey: "voidcaller-full-ep/ep1-01-the-hollow.mp3", range: null, contentType: "audio/mpeg" });
    expect(repository.recordMediaAuthorization).toHaveBeenCalledWith(expect.objectContaining({ action: "MEDIA_AUTHORIZED", reason: "SIGNED_OBJECT_URL" }));
  });

  it("denies expired and revoked grants before private storage is opened", async () => {
    for (const grant of [
      { grant_id: "expired", wallet_address: wallet, experience_id: experience.id, media_type: "AUDIO", expires_at: new Date(Date.now() - 1).toISOString(), revoked_at: null, metadata: {} },
      { grant_id: "revoked", wallet_address: wallet, experience_id: experience.id, media_type: "AUDIO", expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: new Date().toISOString(), metadata: {} },
    ]) {
      const storage = { open: vi.fn() };
      const { gateway, repository } = harness({ grant, storage });
      await expect(gateway.openMedia({ request: request(), grantId: grant.grant_id })).rejects.toMatchObject({ code: grant.revoked_at ? "MEDIA_GRANT_REVOKED" : "MEDIA_GRANT_EXPIRED" });
      expect(storage.open).not.toHaveBeenCalled();
      expect(repository.recordMediaAuthorization).toHaveBeenCalledWith(expect.objectContaining({ action: "MEDIA_DENIED" }));
    }
  });

  it("revokes only the authenticated wallet's grant and writes audit records", async () => {
    const { gateway, repository } = harness();
    await expect(gateway.revokeGrant({ request: request(), input: { wallet, grantId: "grant-1", reason: "logout" } })).resolves.toMatchObject({ state: "REVOKED", grantId: "grant-1" });
    expect(repository.revokeMediaGrant).toHaveBeenCalledWith({ grantId: "grant-1", wallet, reason: "logout" });
    expect(repository.recordMediaAuthorization).toHaveBeenCalledWith(expect.objectContaining({ action: "REVOKED" }));
    await expect(gateway.revokeGrant({ request: request(), input: { wallet: otherWallet, grantId: "grant-1" } })).rejects.toMatchObject({ code: "WALLET_MISMATCH" });
  });
});

describe("public IPFS legacy audio", () => {
  const legacyRequirement = (tokenId) => ({ type: "erc1155-balance", contract: LEGACY_CONTRACT, tokenIds: [String(tokenId)], minAmount: "1", chainId: LEGACY_CHAIN_ID });
  const publicEntry = (tokenId, overrides = {}) => ({ mediaType: "AUDIO", source: "public-ipfs", uri: LEGACY_IPFS_MEDIA[tokenId].animationUrl, contentType: LEGACY_IPFS_MEDIA[tokenId].audioContentType, ...overrides });
  const legacyExperience = (tokenId, entry = publicEntry(tokenId), requirements = [legacyRequirement(tokenId)]) => ({ id: `voidcaller-legacy-track-${tokenId}`, artist_id: "voidcaller", status: "PUBLISHED", requirements, media_config: { protected: true, protectedMedia: [entry] } });
  const input = (row) => ({ wallet, experienceId: row.id, mediaType: "AUDIO" });

  function legacyHarness(row, { grant = null, publicIpfsGateway } = {}) {
    const built = harness({ grant });
    built.db.query.mockImplementation(async (sql) => (String(sql).includes("media_assets") ? { rows: [assetRow] } : { rows: [row] }));
    const ownershipVerifier = vi.fn().mockResolvedValue({ owns: true, state: "CONFIRMED", chainId: LEGACY_CHAIN_ID, watermark: "43114:legacy:live" });
    const storage = { open: vi.fn() };
    const gateway = new ProtectedMediaGateway({ db: built.db, repository: built.repository, authenticator: async () => ({ wallet }), ownershipVerifier, storage, mediaConfig, publicIpfsGateway });
    return { ...built, gateway, ownershipVerifier, storage };
  }

  it("grants a holder the token's own public animation_url and redirects to the gateway without touching private storage", async () => {
    for (const tokenId of [0, 1, 2, 3]) {
      const row = legacyExperience(tokenId);
      const { gateway, repository, db, storage } = legacyHarness(row);
      const result = await gateway.issueGrant({ request: request(), input: input(row) });
      expect(result).toMatchObject({ state: "CONFIRMED", accessUrl: expect.stringMatching(/^\/api\/media\//) });
      expect(result.accessUrl).toMatch(/^\/api\/media\/[0-9a-f-]{36}$/);
      expect(db.query.mock.calls.some(([sql]) => String(sql).includes("media_assets"))).toBe(false);
      const created = repository.createGrant.mock.calls[0][0];
      expect(created.metadata).toEqual({ publicIpfsUri: LEGACY_IPFS_MEDIA[tokenId].animationUrl, contentType: LEGACY_IPFS_MEDIA[tokenId].audioContentType, entitlementState: "CONFIRMED" });

      const activeGrant = { grant_id: created.grantId, wallet_address: wallet, experience_id: row.id, media_type: "AUDIO", expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null, metadata: created.metadata };
      repository.getMediaGrant.mockResolvedValue(activeGrant);
      const media = await gateway.openMedia({ request: request({ headers: { range: "bytes=0-1" } }), grantId: created.grantId });
      expect(media).toEqual({ type: "redirect", url: `https://gateway.pinata.cloud/ipfs/${LEGACY_IPFS_MEDIA[tokenId].animationUrl.slice(7)}` });
      expect(storage.open).not.toHaveBeenCalled();
      expect(repository.recordMediaAuthorization).toHaveBeenCalledWith(expect.objectContaining({ action: "MEDIA_AUTHORIZED", reason: "PUBLIC_IPFS_URL" }));
    }
  });

  it("serves the redirect over HTTP as a 302 to the public gateway", async () => {
    const row = legacyExperience(1);
    const grant = { grant_id: "grant-legacy", wallet_address: wallet, experience_id: row.id, media_type: "AUDIO", expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null, metadata: { publicIpfsUri: LEGACY_IPFS_MEDIA[1].animationUrl, contentType: "audio/mpeg" } };
    const { gateway } = legacyHarness(row, { grant });
    const response = responseDouble();
    await createApiHandler({ service: {}, mediaGateway: gateway })(requestDouble({ url: "/api/media/grant-legacy" }), response);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.mp3");
  });

  it("fails closed for a public-ipfs entry that is not the gated token's own animation_url", async () => {
    const cases = [
      legacyExperience(1, publicEntry(1, { uri: "ipfs://bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234/track.wav" })),
      legacyExperience(1, publicEntry(2)),
      legacyExperience(1, publicEntry(1), [legacyRequirement(2)]),
      legacyExperience(1, publicEntry(1), [{ ...legacyRequirement(1), chainId: 43113 }]),
      legacyExperience(1, publicEntry(1), [{ type: "erc1155-balance", contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenIds: ["1"], minAmount: "1" }]),
      legacyExperience(1, publicEntry(1), [legacyRequirement(1), { type: "erc1155-balance", contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenIds: ["7"], minAmount: "1" }]),
      legacyExperience(1, publicEntry(1), []),
    ];
    for (const row of cases) {
      const { gateway, repository, ownershipVerifier } = legacyHarness(row);
      await expect(gateway.issueGrant({ request: request(), input: input(row) })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_CONFIGURED", status: 503 });
      expect(ownershipVerifier).not.toHaveBeenCalled();
      expect(repository.createGrant).not.toHaveBeenCalled();
    }
  });

  it("keeps the private-storage path for any entry that names an uploaded asset", async () => {
    const row = legacyExperience(1, publicEntry(1, { assetId: "asset-1" }));
    row.artist_id = "artist-1";
    const { gateway, repository, db } = legacyHarness(row);
    await gateway.issueGrant({ request: request(), input: input(row) });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("media_assets"))).toBe(true);
    expect(repository.createGrant.mock.calls[0][0].metadata).toMatchObject({ storageKey: assetRow.storage_key });
    expect(repository.createGrant.mock.calls[0][0].metadata.publicIpfsUri).toBeUndefined();
  });

  it("refuses to redirect a grant whose stored URI is not an allowlisted token audio file", async () => {
    const grant = { grant_id: "tampered", wallet_address: wallet, experience_id: "voidcaller-legacy-track-1", media_type: "AUDIO", expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null, metadata: { publicIpfsUri: "ipfs://bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234/x.wav" } };
    const { gateway, repository, storage } = legacyHarness(legacyExperience(1), { grant });
    await expect(gateway.openMedia({ request: request(), grantId: "tampered" })).rejects.toMatchObject({ code: "MEDIA_GRANT_CONFIGURATION_INVALID", status: 500 });
    expect(storage.open).not.toHaveBeenCalled();
    expect(repository.recordMediaAuthorization).not.toHaveBeenCalledWith(expect.objectContaining({ action: "MEDIA_AUTHORIZED" }));
  });

  it("only accepts an HTTPS public gateway override", () => {
    expect(() => legacyHarness(legacyExperience(1), { publicIpfsGateway: "http://gateway.example/ipfs/" })).toThrow(/HTTPS/);
    expect(legacyHarness(legacyExperience(1), { publicIpfsGateway: "https://gateway.example/ipfs/" }).gateway.publicIpfsGateway).toBe("https://gateway.example/ipfs/");
  });
});

describe("private storage and old public paths", () => {
  it("streams a private filesystem object with byte-range support", async () => {
    const root = await mkdtemp(join(tmpdir(), "voidcaller-media-"));
    try {
      await writeFile(join(root, "track.mp3"), "abcdef");
      const storage = new PrivateMediaStorage({ config: { ...mediaConfig, privateRoot: root, maxBytes: 10 } });
      const media = await storage.open({ storageKey: "track.mp3", range: "bytes=1-3" });
      expect(media).toMatchObject({ type: "stream", contentType: "audio/mpeg", contentLength: 3, totalLength: 6, start: 1, end: 3, partial: true });
      media.stream.destroy();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a public preview but removes old public full-resolution paths", async () => {
    await expect(access(new URL("../public/assets/audio-preview/ep1-01-the-hollow-preview.mp3", import.meta.url))).resolves.toBeUndefined();
    await expect(access(new URL("../public/assets/audio/ep1-01-the-hollow.mp3", import.meta.url))).rejects.toThrow();
    const handler = createApiHandler({ service: {} });
    const response = responseDouble();
    await handler(requestDouble({ url: "/assets/audio/ep1-01-the-hollow.mp3" }), response);
    expect(response.status).toBe(404);
  });

  it("requires Pinata private media configuration in production", () => {
    expect(() => loadMediaConfig({ NODE_ENV: "production", MEDIA_STORAGE_DRIVER: "filesystem" })).toThrow(/requires MEDIA_STORAGE_DRIVER=pinata/);
    expect(() => loadMediaConfig({ NODE_ENV: "production", MEDIA_STORAGE_DRIVER: "object" })).toThrow(/requires MEDIA_STORAGE_DRIVER=pinata/);
    const config = loadMediaConfig({ NODE_ENV: "production", MEDIA_STORAGE_DRIVER: "pinata", PINATA_JWT: "p".repeat(32), PINATA_GATEWAY_URL: "https://media.example", MEDIA_AUDIT_HASH_SECRET: "b".repeat(32) });
    expect(config).toMatchObject({ driver: "pinata", pinata: { gateway: "https://media.example" }, objectUrlHosts: ["media.example"] });
  });

  it("defaults to Pinata in production when MEDIA_STORAGE_DRIVER is absent or empty", () => {
    const pinataEnv = { NODE_ENV: "production", PINATA_JWT: "p".repeat(32), PINATA_GATEWAY_URL: "https://media.example", MEDIA_AUDIT_HASH_SECRET: "b".repeat(32) };
    const missing = loadMediaConfig(pinataEnv);
    expect(missing).toMatchObject({ driver: "pinata", pinata: { gateway: "https://media.example" }, objectUrlHosts: ["media.example"] });
    const empty = loadMediaConfig({ ...pinataEnv, MEDIA_STORAGE_DRIVER: "" });
    expect(empty).toMatchObject({ driver: "pinata" });
    const blank = loadMediaConfig({ ...pinataEnv, MEDIA_STORAGE_DRIVER: "   " });
    expect(blank).toMatchObject({ driver: "pinata" });
  });

  it("preserves an explicitly supplied MEDIA_STORAGE_DRIVER value", () => {
    const filesystem = loadMediaConfig({ MEDIA_STORAGE_DRIVER: "filesystem" });
    expect(filesystem).toMatchObject({ driver: "filesystem" });
    const object = loadMediaConfig({ MEDIA_STORAGE_DRIVER: "object", R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "void-private", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "s".repeat(32), MEDIA_OBJECT_URL_HOSTS: "media.example", MEDIA_OBJECT_PREFIXES: "record" });
    expect(object).toMatchObject({ driver: "object", r2: { bucket: "void-private" } });
  });

  it("still rejects an explicitly supplied invalid MEDIA_STORAGE_DRIVER value", () => {
    expect(() => loadMediaConfig({ MEDIA_STORAGE_DRIVER: "garbage" })).toThrow(/MEDIA_STORAGE_DRIVER must be filesystem, pinata, or object/);
    expect(() => loadMediaConfig({ NODE_ENV: "production", MEDIA_STORAGE_DRIVER: "garbage" })).toThrow(/MEDIA_STORAGE_DRIVER must be filesystem, pinata, or object/);
  });

  it("signs only configured R2 prefixes and accepts only approved HTTPS URLs", async () => {
    const config = { driver: "object", r2: { bucket: "void-private", endpoint: "https://a".repeat(1), accessKeyId: "access", secretAccessKey: "secret" }, objectUrlHosts: ["media.example"], protectedPrefixes: ["record"], signedUrlTtlSeconds: 60 };
    const signer = vi.fn().mockResolvedValue("https://media.example/audio?signature=opaque");
    const allowed = new PrivateMediaStorage({ config, signer });
    await expect(allowed.open({ storageKey: "record/track.mp3" })).resolves.toMatchObject({ type: "redirect", url: "https://media.example/audio?signature=opaque" });
    expect(signer).toHaveBeenCalledWith("record/track.mp3");
    await expect(allowed.open({ storageKey: "other/track.mp3" })).rejects.toThrow(/outside the configured media prefixes/);
    const blocked = new PrivateMediaStorage({ config, signer: vi.fn().mockResolvedValue("https://untrusted.example/audio") });
    await expect(blocked.open({ storageKey: "record/track.mp3" })).rejects.toThrow(/unapproved/);
  });

  it("fails closed when R2 signing fails or a key is unsafe", async () => {
    const config = { driver: "object", objectUrlHosts: ["media.example"], protectedPrefixes: ["record"], signedUrlTtlSeconds: 60 };
    const storage = new PrivateMediaStorage({ config, signer: vi.fn().mockRejectedValue(new Error("R2 unavailable")) });
    await expect(storage.open({ storageKey: "record/track.mp3" })).rejects.toThrow(/signing failed/);
    await expect(storage.open({ storageKey: "record/../secret" })).rejects.toThrow(/Invalid media key/);
  });

  it("creates a Pinata private download link without exposing the JWT", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: "https://media.example/files/cid?X-Signature=opaque" }) });
    vi.stubGlobal("fetch", fetchImpl);
    const config = { driver: "pinata", pinata: { jwt: "secret-jwt", gateway: "https://media.example", endpoint: "https://api.pinata.cloud/v3/files/private/download_link" }, objectUrlHosts: ["media.example"], signedUrlTtlSeconds: 60 };
    const storage = new PrivateMediaStorage({ config });
    await expect(storage.open({ storageKey: "bafkreitestcid123" })).resolves.toMatchObject({ type: "redirect", url: "https://media.example/files/cid?X-Signature=opaque" });
    expect(fetchImpl).toHaveBeenCalledWith(config.pinata.endpoint, expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer secret-jwt" }), body: expect.stringContaining('"expires":60') }));
    vi.unstubAllGlobals();
  });
});
