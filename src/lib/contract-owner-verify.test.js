import { describe, expect, it } from "vitest";
import { fetchArtistVerification, verificationBadgeVisible } from "./contract-owner-verify.js";

describe("artist verification badge", () => {
  it("renders only when a verification record exists", async () => {
    expect(verificationBadgeVisible(null)).toBe(false);
    expect(verificationBadgeVisible({ verified: false })).toBe(false);
    expect(verificationBadgeVisible({ verified: true, contract: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee" })).toBe(true);
    const record = await fetchArtistVerification("voidcaller", {
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: { verified: true } }) }),
    });
    expect(record.verified).toBe(true);
  });
});
