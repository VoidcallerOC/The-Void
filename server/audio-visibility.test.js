import { readFile, access } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { canonicalMetadata } from "./metadata-storage.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { IndexedOwnershipVerifier } from "./ownership.js";
import { ArtistStudioService } from "./studio-service.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";

// Audio visibility contract for new gated releases:
//   PUBLIC       artwork, token metadata, ~30 s preview (animation_url)
//   TOKEN-GATED  full-length audio (protected media)
//   AUTHORITY    ERC-1155 balance from the project's indexer, never OpenSea

const owner = "0x1111111111111111111111111111111111111111";
const nonHolder = "0x2222222222222222222222222222222222222222";
const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PREVIEW_URI = "ipfs://bafypublicpreview30s";
const FULL_TRACK_KEY = "bafyprivatefulltrackcid";
const mediaConfig = { driver: "filesystem", privateRoot: "/private-media", grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 1024 * 1024, auditHashSecret: "test-audit-secret" };
const gatedExperience = { id: "experience-full", artist_id: "artist-a", status: "PUBLISHED", requirements: [{ type: "erc1155-balance", contract, chainId: 43113, tokenIds: ["7"], minAmount: "1" }], media_config: { protected: true, protectedMedia: [{ mediaType: "AUDIO", assetId: "asset-full", contentType: "audio/mpeg" }] } };
const request = (headers = {}) => ({ headers, requestId: "request-1", ip: "127.0.0.1" });

function gateway({ identity = { wallet: owner }, ownership = { owns: true, state: "FINALIZED", chainId: 43113 }, grant = null } = {}) {
  const repository = {
    inTransaction: vi.fn(async (operation) => operation(repository)),
    createGrant: vi.fn(async (input) => ({ grant_id: input.grantId, expires_at: input.expiresAt.toISOString(), ...input })),
    recordMediaAuthorization: vi.fn().mockResolvedValue({}),
    appendAuditEvent: vi.fn().mockResolvedValue({}),
    getMediaGrant: vi.fn().mockResolvedValue(grant),
  };
  const db = { query: vi.fn(async (sql) => (String(sql).includes("media_assets") ? { rows: [{ id: "asset-full", artist_id: "artist-a", storage_key: FULL_TRACK_KEY }] } : { rows: [gatedExperience] })) };
  const ownershipVerifier = vi.fn().mockResolvedValue(ownership);
  const storage = { open: vi.fn().mockResolvedValue({ type: "redirect", url: "https://media.example/signed?expires=60" }) };
  return { instance: new ProtectedMediaGateway({ db, repository, authenticator: async () => identity, ownershipVerifier, storage, mediaConfig }), repository, storage, ownershipVerifier };
}

function studio({ registeredPreviews = [PREVIEW_URI], privateKeys = [FULL_TRACK_KEY], metadataStorage = { write: vi.fn().mockResolvedValue({ uri: "ipfs://metadata" }) } } = {}) {
  const release = { id: "release-a", artist_id: "artist-a", slug: "new-gated-single", title: "New Gated Single", description: "A single.", status: "DRAFT", release_metadata: {}, published_at: null, display_name: "Voidcaller", owner_wallet: owner };
  const edition = { id: "edition-a", release_id: release.id, contract_id: "contract-a", title: "New Gated Single", description: null, tier: null, supply: "10", application_metadata: {}, metadata_uri: null, metadata_version: null };
  const db = { query: vi.fn(async (sql, params = []) => {
    const text = String(sql);
    if (text.includes("FROM audit_events")) return { rows: registeredPreviews.includes(params[1]) ? [{ id: "audit-1" }] : [] };
    if (text.includes("FROM media_assets WHERE artist_id=$1 AND storage_key=$2")) return { rows: privateKeys.includes(params[1]) ? [{ id: "asset-full" }] : [] };
    if (text.includes("FROM media_assets")) return { rows: [{ id: "asset-full", media_type: "AUDIO", metadata: { contentSha256: "f".repeat(64) } }] };
    if (text.includes("FROM experiences")) return { rows: [{ id: "experience-full", title: "Full track", description: null, experience_type: "AUDIO", media_config: gatedExperience.media_config, version: 1 }] };
    if (text.includes("FROM editions")) return { rows: [edition] };
    if (text.includes("FROM releases")) return { rows: [release] };
    return { rows: [] };
  }) };
  const repository = { saveToken: vi.fn(async (input) => input), appendAuditEvent: vi.fn(async () => ({})), inTransaction: vi.fn(async (callback) => callback(repository)) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository, metadataStorage, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { info: vi.fn() } });
  return { instance, repository, db, metadataStorage };
}

describe("audio visibility: public preview, token-gated full track", () => {
  it("1. animation_url is the public preview", () => {
    const { metadata } = canonicalMetadata({ artist: { name: "Voidcaller" }, release: { title: "Single" }, edition: { title: "Single", supply: "10" }, artwork: "ipfs://art", previewAudio: PREVIEW_URI });
    expect(metadata.animation_url).toBe(PREVIEW_URI);
  });

  it("2. full-length audio is never exposed through token metadata", () => {
    // Even if a draft carries other audio fields, only the vetted preview reaches the metadata.
    const { metadata } = canonicalMetadata({ artist: { name: "Voidcaller" }, release: { title: "Single" }, edition: { title: "Single", supply: "10", application_metadata: { audio: `ipfs://${FULL_TRACK_KEY}`, previewAudio: `ipfs://${FULL_TRACK_KEY}` } }, audio: `ipfs://${FULL_TRACK_KEY}` });
    expect(metadata).not.toHaveProperty("animation_url");
    expect(JSON.stringify(metadata)).not.toContain(FULL_TRACK_KEY);
  });

  it("2b. publishing rejects an animation_url that is not a registered preview or points at private storage", async () => {
    await expect(studio().instance.publishMetadata({ request: request(), releaseId: "release-a", input: { releaseType: "EP", previewAudio: "ipfs://bafysomeotherfile" } })).rejects.toMatchObject({ code: "PREVIEW_AUDIO_NOT_REGISTERED" });
    const sneaky = studio({ registeredPreviews: [`ipfs://${FULL_TRACK_KEY}`] });
    await expect(sneaky.instance.publishMetadata({ request: request(), releaseId: "release-a", input: { releaseType: "EP", previewAudio: `ipfs://${FULL_TRACK_KEY}` } })).rejects.toMatchObject({ code: "PREVIEW_AUDIO_IS_PRIVATE" });
    expect(sneaky.metadataStorage.write).not.toHaveBeenCalled();
  });

  it("2c. a published token's metadata carries the preview and no private storage address", async () => {
    const { instance, repository } = studio();
    await instance.publishMetadata({ request: request(), releaseId: "release-a", input: { releaseType: "EP", previewAudio: PREVIEW_URI } });
    const published = repository.saveToken.mock.calls[0][0].metadata;
    expect(published.animation_url).toBe(PREVIEW_URI);
    expect(JSON.stringify(published)).not.toContain(FULL_TRACK_KEY);
    expect(JSON.stringify(published)).not.toMatch(/storageKey|storage_key/);
  });

  it("3. a non-holder wallet is denied the full track", async () => {
    const { instance, repository } = gateway({ identity: { wallet: nonHolder }, ownership: { owns: false, state: "CONFIRMED" } });
    await expect(instance.issueGrant({ request: request(), input: { wallet: nonHolder, experienceId: gatedExperience.id, mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "EXPERIENCE_ENTITLEMENT_REQUIRED" });
    expect(repository.createGrant).not.toHaveBeenCalled();
  });

  it("4. a holder wallet is authorized, and the grant never reveals the storage address", async () => {
    const { instance, repository } = gateway();
    const result = await instance.issueGrant({ request: request(), input: { wallet: owner, experienceId: gatedExperience.id, mediaType: "AUDIO" } });
    expect(result).toMatchObject({ state: "CONFIRMED", accessUrl: expect.stringMatching(/^\/api\/media\/[0-9a-f-]{36}$/) });
    expect(JSON.stringify(result)).not.toContain(FULL_TRACK_KEY);
    expect(repository.createGrant).toHaveBeenCalledOnce();
  });

  it("5. a missing or invalid wallet signature is denied before ownership is checked", async () => {
    const { instance, ownershipVerifier } = gateway({ identity: null });
    await expect(instance.issueGrant({ request: request(), input: { wallet: owner, experienceId: gatedExperience.id, mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(ownershipVerifier).not.toHaveBeenCalled();
    const mismatch = gateway({ identity: { wallet: nonHolder } });
    await expect(mismatch.instance.issueGrant({ request: request(), input: { wallet: owner, experienceId: gatedExperience.id, mediaType: "AUDIO" } })).rejects.toBeTruthy();
    expect(mismatch.repository.createGrant).not.toHaveBeenCalled();
  });

  it("6. calling the API directly without a session is denied", async () => {
    const { instance } = gateway({ identity: null });
    const handler = createApiHandler({ service: {}, mediaGateway: instance });
    const response = { status: null, body: "", writeHead(status) { this.status = status; }, end(body = "") { this.body = body; } };
    const body = JSON.stringify({ wallet: owner, experienceId: gatedExperience.id, mediaType: "AUDIO" });
    await handler({ method: "POST", url: "/api/media/grants", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, response);
    expect(response.status).toBe(401);
    expect(response.body).not.toContain(FULL_TRACK_KEY);
  });

  it("7. public previews stay accessible and full-length /assets/audio paths are blocked", async () => {
    await expect(access(new URL("../public/assets/audio-preview/ep1-01-the-hollow-preview.mp3", import.meta.url))).resolves.toBeUndefined();
    await expect(access(new URL("../public/assets/audio/ep1-01-the-hollow.mp3", import.meta.url))).rejects.toThrow();
    const routes = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")).routes;
    const blocked = (path) => routes.some((route) => route.status === 404 && new RegExp(`^${route.src}$`).test(path));
    expect(blocked("/assets/audio/ep1-01-the-hollow.mp3")).toBe(true);
    expect(blocked("/assets/audio")).toBe(true);
    expect(blocked("/assets/audio-preview/ep1-01-the-hollow.mp3")).toBe(true);
    expect(blocked("/assets/audio-preview/ep1-01-the-hollow-preview.mp3")).toBe(false);
  });

  it("8. full private audio is unreachable without a valid grant", async () => {
    const { instance, storage } = gateway({ grant: null });
    await expect(instance.openMedia({ request: request(), grantId: "guessed-or-forged" })).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it("9. expired and revoked grants are denied before storage is opened", async () => {
    for (const grant of [
      { grant_id: "expired", wallet_address: owner, experience_id: gatedExperience.id, media_type: "AUDIO", expires_at: new Date(Date.now() - 1).toISOString(), revoked_at: null, metadata: { storageKey: FULL_TRACK_KEY } },
      { grant_id: "revoked", wallet_address: owner, experience_id: gatedExperience.id, media_type: "AUDIO", expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: new Date().toISOString(), metadata: { storageKey: FULL_TRACK_KEY } },
    ]) {
      const { instance, storage } = gateway({ grant });
      await expect(instance.openMedia({ request: request(), grantId: grant.grant_id })).rejects.toMatchObject({ code: grant.revoked_at ? "MEDIA_GRANT_REVOKED" : "MEDIA_GRANT_EXPIRED" });
      expect(storage.open).not.toHaveBeenCalled();
    }
    const { instance } = gateway();
    const issued = await instance.issueGrant({ request: request(), input: { wallet: owner, experienceId: gatedExperience.id, mediaType: "AUDIO" } });
    expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(mediaConfig.grantTtlSeconds * 1000);
  });

  it("10. ownership comes from the indexed ERC-1155 balance, with no marketplace dependency", async () => {
    expect(IndexedOwnershipVerifier).toBeTypeOf("function");
    const source = await readFile(new URL("./ownership.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/opensea/i);
    const gatewaySource = await readFile(new URL("./media-gateway.js", import.meta.url), "utf8");
    expect(gatewaySource).not.toMatch(/opensea/i);
  });
});
