import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { loadMediaConfig } from "./config.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { PrivateMediaStorage } from "./media-storage.js";

const wallet = "0x1111111111111111111111111111111111111111";
const otherWallet = "0x2222222222222222222222222222222222222222";
const mediaConfig = { driver: "filesystem", privateRoot: "/private-media", grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 1024 * 1024, auditHashSecret: "test-audit-secret" };
const experience = { id: "voidcaller-full-ep", status: "PUBLISHED", requirements: [{ type: "erc1155-balance" }], media_config: { protected: true, protectedMedia: [{ mediaType: "AUDIO", storageKey: "voidcaller-full-ep/ep1-01-the-hollow.mp3", contentType: "audio/mpeg" }] } };

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
  const db = { query: vi.fn().mockResolvedValue({ rows: [experience] }) };
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

  it("requires provider-neutral object storage configuration in production", () => {
    expect(() => loadMediaConfig({ NODE_ENV: "production", MEDIA_STORAGE_DRIVER: "filesystem" })).toThrow(/requires MEDIA_STORAGE_DRIVER=object/);
    const config = loadMediaConfig({ NODE_ENV: "production", MEDIA_STORAGE_DRIVER: "object", MEDIA_OBJECT_SIGNER_ENDPOINT: "https://signer.example/internal", MEDIA_OBJECT_SIGNER_TOKEN: "a".repeat(24), MEDIA_OBJECT_URL_HOSTS: "media.example", MEDIA_AUDIT_HASH_SECRET: "b".repeat(32) });
    expect(config).toMatchObject({ driver: "object", signerEndpoint: "https://signer.example/internal", objectUrlHosts: ["media.example"] });
  });

  it("accepts only approved HTTPS object-storage signed URLs", async () => {
    const config = { driver: "object", signerEndpoint: "https://signer.example/internal", signerToken: "a".repeat(24), objectUrlHosts: ["media.example"], signedUrlTtlSeconds: 60 };
    const allowed = new PrivateMediaStorage({ config, fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ url: "https://media.example/audio?signature=opaque" }) }) });
    await expect(allowed.open({ storageKey: "record/track.mp3" })).resolves.toMatchObject({ type: "redirect", url: "https://media.example/audio?signature=opaque" });
    const blocked = new PrivateMediaStorage({ config, fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ url: "https://untrusted.example/audio" }) }) });
    await expect(blocked.open({ storageKey: "record/track.mp3" })).rejects.toThrow(/unapproved/);
  });
});
