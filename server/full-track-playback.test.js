import { Buffer } from "node:buffer";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { loadMediaConfig } from "./config.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { PrivateMediaStorage } from "./media-storage.js";

// Regression coverage for the two Forgive & Forget full-track experiences:
// the full record (AUDIO, a 65 MB WAV) and the Stranger Things demo (DEMO, an
// MP3) are independent experiences of one holder-gated token, each delivered
// through the API from private storage under its own opaque grant.

const wallet = "0x6a86efa012feda64b70112022487fee22e67d2fb";
const stranger = "0x2222222222222222222222222222222222222222";
const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const requirement = { type: "erc1155-balance", chainId: 43114, contract: "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103", tokenIds: [TOKEN], minAmount: "1" };
const FULL_CID = "bafybeifrip2nxn5jila3ibhcp2dp7khw6ja55eggpl7hzhoxyxhxergwuy";
const DEMO_CID = "bafybeicwpu2qoc5m2zdda3dozec6shre7qvhmmvsespnzhxknh4huvvvwi";
const assets = {
  "asset-full": { id: "asset-full", artist_id: "voidcaller", storage_key: FULL_CID, metadata: { byteSize: "65861868" } },
  "asset-demo": { id: "asset-demo", artist_id: "voidcaller", storage_key: DEMO_CID, metadata: { byteSize: "4007809" } },
};
const experiences = {
  full: { id: "experience-ff-full-track", artist_id: "voidcaller", status: "PUBLISHED", requirements: [requirement], media_config: { protected: true, primary: true, productType: "FULL_RECORD", deliveryType: "AUDIO", protectedMedia: [{ assetId: "asset-full", mediaType: "AUDIO", contentType: "audio/wav" }] } },
  demo: { id: "experience-ff-experience-audio", artist_id: "voidcaller", status: "PUBLISHED", requirements: [requirement], media_config: { protected: true, primary: false, productType: "DEMO", deliveryType: "DEMO", protectedMedia: [{ assetId: "asset-demo", mediaType: "DEMO", contentType: "audio/mpeg" }] } },
};
const pinataConfig = { driver: "pinata", delivery: "stream", pinata: { jwt: "secret-jwt", gateway: "https://media.example", endpoint: "https://api.pinata.cloud/v3/files/private/download_link" }, objectUrlHosts: ["media.example"], grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 104857600, auditHashSecret: "s" };

function request({ headers = {}, requestId = "request-1" } = {}) { return { headers, requestId, ip: "127.0.0.1" }; }

function harness({ identity = { wallet }, owns = true, storage } = {}) {
  const grants = new Map();
  const repository = {
    inTransaction: vi.fn(async (operation) => operation(repository)),
    createGrant: vi.fn(async (input) => { const row = { grant_id: input.grantId, wallet_address: input.wallet, experience_id: input.experienceId, media_type: input.mediaType, expires_at: input.expiresAt.toISOString(), revoked_at: null, metadata: input.metadata }; grants.set(input.grantId, row); return row; }),
    recordMediaAuthorization: vi.fn().mockResolvedValue({}),
    appendAuditEvent: vi.fn().mockResolvedValue({}),
    getMediaGrant: vi.fn(async ({ grantId }) => grants.get(grantId) || null),
    revokeMediaGrant: vi.fn(),
  };
  const db = { query: vi.fn(async (sql, params) => {
    if (String(sql).includes("FROM media_assets")) return { rows: assets[params[0]] ? [assets[params[0]]] : [] };
    const row = Object.values(experiences).find((item) => item.id === params[0]);
    return { rows: row ? [row] : [] };
  }) };
  const ownershipVerifier = vi.fn(async ({ wallet: subject }) => (owns && subject === wallet ? { owns: true, state: "CONFIRMED", chainId: 43114, watermark: `43114:${TOKEN}:98046247:2` } : { owns: false, state: "NONE" }));
  const gateway = new ProtectedMediaGateway({ db, repository, authenticator: async () => identity, ownershipVerifier, storage: storage || { open: vi.fn() }, mediaConfig: pinataConfig });
  return { gateway, db, repository, ownershipVerifier };
}

function signedStorage({ status = 206, body = "0123456789", range = "bytes 2-4/10", length = null, contentType = "audio/wav" } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    if (String(url).includes("download_link")) return { ok: true, status: 200, json: async () => ({ data: `https://media.example/files/${new URL(JSON.parse(options.body).url).pathname.split("/").pop()}?X-Signature=opaque` }) };
    const headers = new Map([["content-type", contentType]]);
    if (status === 206 && range) headers.set("content-range", range);
    if (length !== null) headers.set("content-length", String(length));
    return { status, headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null }, body: status === 200 || status === 206 ? Readable.toWeb(Readable.from([Buffer.from(body)])) : { cancel: async () => {} } };
  });
  return { storage: new PrivateMediaStorage({ config: pinataConfig }), fetchImpl, calls };
}

async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString(); }

describe("two independent full-track experiences", () => {
  it("issues separate grants for the full record and the demo, each bound to its own asset", async () => {
    const { gateway, repository } = harness();
    const full = await gateway.issueGrant({ request: request(), input: { wallet, experienceId: experiences.full.id, mediaType: "AUDIO" } });
    const demo = await gateway.issueGrant({ request: request(), input: { wallet, experienceId: experiences.demo.id, mediaType: "DEMO" } });
    expect(full.grantId).not.toBe(demo.grantId);
    const [fullGrant, demoGrant] = repository.createGrant.mock.calls.map(([input]) => input);
    expect(fullGrant).toMatchObject({ experienceId: experiences.full.id, mediaType: "AUDIO", metadata: { storageKey: FULL_CID, contentType: "audio/wav", byteSize: 65861868 } });
    expect(demoGrant).toMatchObject({ experienceId: experiences.demo.id, mediaType: "DEMO", metadata: { storageKey: DEMO_CID, contentType: "audio/mpeg", byteSize: 4007809 } });
    for (const url of [full.accessUrl, demo.accessUrl]) { expect(url).toMatch(/^\/api\/media\//); expect(url).not.toContain("baf"); }
  });

  it("refuses the demo's AUDIO type and the full record's DEMO type rather than cross-serving", async () => {
    const { gateway } = harness();
    await expect(gateway.issueGrant({ request: request(), input: { wallet, experienceId: experiences.demo.id, mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_CONFIGURED" });
    await expect(gateway.issueGrant({ request: request(), input: { wallet, experienceId: experiences.full.id, mediaType: "DEMO" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_CONFIGURED" });
  });

  it("denies both experiences to a wallet that does not hold the token and records each denial", async () => {
    const { gateway, repository } = harness({ identity: { wallet: stranger } });
    for (const [experienceId, mediaType] of [[experiences.full.id, "AUDIO"], [experiences.demo.id, "DEMO"]]) {
      await expect(gateway.issueGrant({ request: request(), input: { wallet: stranger, experienceId, mediaType } })).rejects.toMatchObject({ code: "EXPERIENCE_ENTITLEMENT_REQUIRED", status: 403 });
    }
    expect(repository.appendAuditEvent.mock.calls.filter(([event]) => event.eventType === "MEDIA_ACCESS_DENIED")).toHaveLength(2);
    expect(repository.createGrant).not.toHaveBeenCalled();
  });

  it("only serves experiences whose edition is published", async () => {
    const { gateway, db } = harness();
    await gateway.issueGrant({ request: request(), input: { wallet, experienceId: experiences.full.id, mediaType: "AUDIO" } });
    const [sql] = db.query.mock.calls.find(([text]) => String(text).includes("FROM experiences"));
    expect(String(sql)).toMatch(/edition_id IS NULL OR EXISTS \(SELECT 1 FROM editions e WHERE e\.id=experiences\.edition_id AND e\.status='PUBLISHED'\)/);
  });

  it("relays each granted object through the API with the browser's byte range and never redirects to storage", async () => {
    const { storage, fetchImpl, calls } = signedStorage({ status: 206, body: "234", range: "bytes 2-4/65861868" });
    const { gateway, repository } = harness({ storage: { open: (input) => storage.open({ ...input, fetchImpl }) } });
    const grant = await gateway.issueGrant({ request: request(), input: { wallet, experienceId: experiences.full.id, mediaType: "AUDIO" } });
    const media = await gateway.openMedia({ request: request({ headers: { range: "bytes=2-4" } }), grantId: grant.grantId });
    expect(media).toMatchObject({ type: "stream", contentType: "audio/wav", contentLength: 3, totalLength: 65861868, start: 2, end: 4, partial: true });
    await expect(collect(media.stream)).resolves.toBe("234");
    expect(calls[0].url).toContain("download_link");
    expect(calls[1]).toMatchObject({ url: `https://media.example/files/${FULL_CID}?X-Signature=opaque`, headers: { range: "bytes=2-4", "accept-encoding": "identity" } });
    expect(repository.recordMediaAuthorization).toHaveBeenCalledWith(expect.objectContaining({ action: "MEDIA_AUTHORIZED", reason: "PRIVATE_STREAM" }));
    expect(JSON.stringify(media)).not.toContain("X-Signature");
  });

  it("cuts the byte range itself when the storage gateway ignores Range, using the registered size", async () => {
    const { storage, fetchImpl } = signedStorage({ status: 200, body: "0123456789", length: null, contentType: "audio/mpeg" });
    const media = await storage.open({ storageKey: DEMO_CID, range: "bytes=7-", contentType: "audio/mpeg", totalLength: 10, fetchImpl });
    expect(media).toMatchObject({ type: "stream", contentLength: 3, totalLength: 10, start: 7, end: 9, partial: true });
    await expect(collect(media.stream)).resolves.toBe("789");
  });

  it("serves the whole object when no range is requested", async () => {
    const { storage, fetchImpl } = signedStorage({ status: 200, body: "0123456789", length: 10 });
    const media = await storage.open({ storageKey: DEMO_CID, contentType: null, fetchImpl });
    expect(media).toMatchObject({ type: "stream", contentType: "audio/wav", contentLength: 10, totalLength: 10, start: 0, end: 9, partial: false });
    await expect(collect(media.stream)).resolves.toBe("0123456789");
  });

  it("fails closed, without the signed link, when the storage gateway refuses or times out", async () => {
    for (const [status, code] of [[403, "MEDIA_DOWNLOAD_FORBIDDEN"], [504, "MEDIA_OBJECT_UNAVAILABLE"]]) {
      const { storage, fetchImpl } = signedStorage({ status });
      await expect(storage.open({ storageKey: FULL_CID, fetchImpl })).rejects.toMatchObject({ status: 502, code, upstream: { status } });
      await expect(storage.open({ storageKey: FULL_CID, fetchImpl }).catch((error) => JSON.stringify({ message: error.message, upstream: error.upstream }))).resolves.not.toContain("X-Signature");
    }
  });

  it("keeps the signed-link redirect when delivery is configured as redirect", async () => {
    const { storage, fetchImpl, calls } = signedStorage();
    storage.config = { ...pinataConfig, delivery: "redirect" };
    await expect(storage.open({ storageKey: FULL_CID, fetchImpl })).resolves.toEqual({ type: "redirect", url: `https://media.example/files/${FULL_CID}?X-Signature=opaque` });
    expect(calls).toHaveLength(1);
  });

  it("answers a ranged HTTP request as 206 with content-range, and a whole stream as 200", async () => {
    const { storage, fetchImpl } = signedStorage({ status: 206, body: "234", range: "bytes 2-4/10" });
    const { gateway } = harness({ storage: { open: (input) => storage.open({ ...input, fetchImpl }) } });
    const grant = await gateway.issueGrant({ request: request(), input: { wallet, experienceId: experiences.demo.id, mediaType: "DEMO" } });
    const handle = createApiHandler({ service: { getOperationalHealth: async () => ({ ok: true }) }, mediaGateway: gateway, allowedOrigins: ["https://www.thevoidstudio.xyz"] });
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
    await handle({ method: "GET", url: `/api/media/${grant.grantId}`, headers: { range: "bytes=2-4", origin: "https://www.thevoidstudio.xyz" }, socket: { remoteAddress: "127.0.0.1" } }, response);
    response.chunks = chunks;
    expect(response.status).toBe(206);
    expect(response.headers).toMatchObject({ "content-type": "audio/mpeg", "content-length": "3", "content-range": "bytes 2-4/10", "accept-ranges": "bytes", "access-control-allow-origin": "https://www.thevoidstudio.xyz" });
    expect(Buffer.concat(response.chunks).toString()).toBe("234");
  });
});

describe("media delivery configuration", () => {
  const base = { NODE_ENV: "production", MEDIA_STORAGE_DRIVER: "pinata", PINATA_JWT: "x".repeat(40), PINATA_GATEWAY_URL: "https://fuchsia.mypinata.cloud", MEDIA_AUDIT_HASH_SECRET: "y".repeat(40) };
  it("streams through the API by default for Pinata and accepts an explicit redirect", () => {
    expect(loadMediaConfig(base).delivery).toBe("stream");
    expect(loadMediaConfig({ ...base, MEDIA_DELIVERY: "redirect" }).delivery).toBe("redirect");
    expect(() => loadMediaConfig({ ...base, MEDIA_DELIVERY: "proxy" })).toThrow(/MEDIA_DELIVERY/);
  });
});
