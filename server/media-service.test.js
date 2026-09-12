import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createMediaService } from "./media-service.js";
import { createPrivateMediaStore, parseByteRange } from "./media-storage.js";
import { createAuthorizationGrant, grantAllows } from "../src/lib/media-auth.js";

const wallet = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const contract = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";

function serviceFor({ owns = true, authenticatedWallet = wallet } = {}) {
  const db = { query: vi.fn()
    .mockResolvedValueOnce({ rows: [{ id: "self-titled", requirements: [{ type: "ownership", contract, chainId: 43114, tokenIds: [0, 1, 2, 3], minAmount: 1 }] }] })
    .mockResolvedValueOnce({ rows: owns ? [{ chain_id: 43114, contract_address: contract, token_id: 1, amount: "1", synchronization_watermark: "w1" }] : [] }) };
  const repository = { createGrant: vi.fn().mockResolvedValue({}), recordMediaAuthorization: vi.fn().mockResolvedValue({}), appendAuditEvent: vi.fn().mockResolvedValue({}) };
  const storage = { stat: vi.fn().mockResolvedValue({ key: "audio/ep1-01-the-hollow.mp3", file: "/private/audio.mp3", size: 10, contentType: "audio/mpeg" }), stream: vi.fn(() => Readable.from(["audio"])) };
  const media = createMediaService({ db, repository, authenticator: async () => ({ wallet: authenticatedWallet }), storage });
  return { media, db, repository, storage };
}

describe("private media authorization", () => {
  it("issues an owner-bound grant and audits access", async () => {
    const { media, repository } = serviceFor();
    const grant = await media.issueGrant({ request: { headers: {} }, mediaKey: "audio/ep1-01-the-hollow.mp3", experienceId: "self-titled", mediaType: "AUDIO", chainId: 43114 });
    expect(grant).toMatchObject({ mediaKey: "audio/ep1-01-the-hollow.mp3", wallet, chainId: 43114 });
    expect(repository.createGrant).toHaveBeenCalledWith(expect.objectContaining({ experienceId: "self-titled", wallet, ownershipChainId: 43114 }));
    expect(repository.recordMediaAuthorization).toHaveBeenCalledWith(expect.objectContaining({ action: "GRANT_ISSUED" }));
  });
  it("rejects a non-owner and records a denial", async () => {
    const { media, repository } = serviceFor({ owns: false });
    await expect(media.issueGrant({ request: { headers: {} }, mediaKey: "audio/ep1-01-the-hollow.mp3", experienceId: "self-titled", mediaType: "AUDIO", chainId: 43114 })).rejects.toMatchObject({ code: "MEDIA_NOT_AUTHORIZED", status: 403 });
    expect(repository.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "MEDIA_ACCESS_DENIED" }));
  });
  it("rejects wrong experience and chain before storage access", async () => {
    const { media, storage } = serviceFor();
    await expect(media.issueGrant({ request: { headers: {} }, mediaKey: "audio/ep1-01-the-hollow.mp3", experienceId: "other", mediaType: "AUDIO", chainId: 43113 })).rejects.toMatchObject({ code: "MEDIA_MISMATCH" });
    expect(storage.stat).not.toHaveBeenCalled();
  });
  it("does not authorize a grant for another wallet, chain, expired, or revoked state", () => {
    const grant = createAuthorizationGrant({ wallet, experienceId: "self-titled", grantId: "g1", chainId: 43114, issuedAt: 100, ttlSeconds: 300 });
    expect(grantAllows(grant, { wallet, experienceId: "self-titled", chainId: 43114, mediaType: "AUDIO", now: 200 })).toBe(true);
    expect(grantAllows(grant, { wallet: "0x1111111111111111111111111111111111111111", experienceId: "self-titled", chainId: 43114, mediaType: "AUDIO", now: 200 })).toBe(false);
    expect(grantAllows(grant, { wallet, experienceId: "self-titled", chainId: 43113, mediaType: "AUDIO", now: 200 })).toBe(false);
    expect(grantAllows(grant, { wallet, experienceId: "self-titled", chainId: 43114, mediaType: "AUDIO", now: 401 })).toBe(false);
    expect(grantAllows({ ...grant, revokedAt: 250 }, { wallet, experienceId: "self-titled", chainId: 43114, mediaType: "AUDIO", now: 200 })).toBe(false);
  });
});

describe("private media storage", () => {
  it("rejects traversal and parses valid byte ranges", async () => {
    const store = createPrivateMediaStore({ root: "/srv/private-media" });
    expect(() => store.resolve("../public/master.mp3")).toThrow(/Invalid media key/);
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=100-101", 100)).toBeNull();
  });
});
