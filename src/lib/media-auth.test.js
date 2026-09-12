import { describe, expect, it } from "vitest";
import { createAuthorizationGrant, createMediaChallenge, isAuthorizationFresh, protectedMediaUrl } from "./media-auth.js";

describe("protected media authorization contract", () => {
  it("creates a wallet-bound challenge and short-lived grant", () => {
    const challenge = createMediaChallenge({ wallet: "0xABC", experienceId: "full-album", nonce: "n1", issuedAt: 100 });
    const grant = createAuthorizationGrant({ wallet: challenge.wallet, experienceId: challenge.experienceId, grantId: "g1", chainId: 43114, issuedAt: 100, ttlSeconds: 300 });
    expect(challenge.statement).toContain("full-album");
    expect(isAuthorizationFresh(grant, { now: 399 })).toBe(true);
    expect(isAuthorizationFresh({ ...grant, now: undefined, expiresAt: 400 }, { now: 400 })).toBe(false);
  });
  it("addresses protected media by opaque grant, never a master filename", () => {
    expect(protectedMediaUrl({ origin: "https://media.example/", grantId: "g/1" })).toBe("https://media.example/media/g%2F1");
  });
});
