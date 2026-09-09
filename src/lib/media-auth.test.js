import { describe, expect, it, vi } from "vitest";
import { createAuthorizationGrant, createMediaChallenge, isAuthorizationFresh, protectedMediaUrl, requestProtectedMediaGrant, revokeProtectedMediaGrant } from "./media-auth.js";

describe("protected media authorization contract", () => {
  it("creates a wallet-bound challenge and short-lived grant", () => {
    const challenge = createMediaChallenge({ wallet: "0xABC", experienceId: "full-album", nonce: "n1", issuedAt: 100 });
    const grant = createAuthorizationGrant({ wallet: challenge.wallet, experienceId: challenge.experienceId, grantId: "g1", issuedAt: 100, ttlSeconds: 300 });
    expect(challenge.statement).toContain("full-album");
    expect(isAuthorizationFresh(grant, { now: 399 })).toBe(true);
    expect(isAuthorizationFresh({ ...grant, now: undefined, expiresAt: 400 }, { now: 400 })).toBe(false);
  });

  it("addresses protected media by opaque grant, never a master filename", () => {
    expect(protectedMediaUrl({ origin: "https://media.example/", grantId: "g/1" })).toBe("https://media.example/media/g%2F1");
  });

  it("requests a verified API media grant and consumes only its opaque access URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ data: { grantId: "opaque-grant", expiresAt: "2030-01-01T00:00:00.000Z", accessUrl: "/api/media/opaque-grant" } }) });
    await expect(requestProtectedMediaGrant({ wallet: "0xabc", experienceId: "voidcaller-full-ep", authHeaders: { authorization: "Bearer session" }, fetchImpl })).resolves.toMatchObject({ grantId: "opaque-grant", accessUrl: "/api/media/opaque-grant" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/media/grants", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer session" }) }));
  });

  it("surfaces media denial and revocation failures without falling back to a master path", async () => {
    const deniedFetch = vi.fn().mockResolvedValue({ ok: false, json: vi.fn().mockResolvedValue({ error: { code: "EXPERIENCE_ENTITLEMENT_REQUIRED", message: "denied" } }) });
    await expect(requestProtectedMediaGrant({ wallet: "0xabc", experienceId: "voidcaller-full-ep", fetchImpl: deniedFetch })).rejects.toMatchObject({ code: "EXPERIENCE_ENTITLEMENT_REQUIRED" });
    const revokeFetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ data: { state: "REVOKED", grantId: "opaque-grant" } }) });
    await expect(revokeProtectedMediaGrant({ wallet: "0xabc", grantId: "opaque-grant", authHeaders: { authorization: "Bearer session" }, fetchImpl: revokeFetch })).resolves.toMatchObject({ state: "REVOKED" });
  });
});
