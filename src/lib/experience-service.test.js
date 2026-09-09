import { describe, expect, it } from "vitest";
import { createCatalogSnapshot, readCatalog, writeCatalog, configureArtistExperience, createChallengeResponse, issueMediaGrant, authorizeMediaRequest, createAuditLog, createRedemption, transitionRedemption, REDEMPTION_STATES } from "./experience-service.js";

function storage() { const values = new Map(); return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; }

const experience = { id: "exp-1", experienceType: "AUDIO", title: "The Record", media: { type: "audio", protected: true } };

describe("Phase 7 experience service", () => {
  it("persists and restores a versioned catalog snapshot", () => {
    const store = storage();
    const snapshot = writeCatalog(store, createCatalogSnapshot({ experiences: [experience] }));
    expect(readCatalog(store).experiences[0].id).toBe("exp-1");
    expect(snapshot.version).toBe(1);
  });

  it("allows only the owning artist to replace an experience", () => {
    const base = createCatalogSnapshot({ experiences: [experience] });
    const updated = configureArtistExperience({ catalog: base, artistId: "artist-1", experience: { ...experience, title: "Updated" } });
    expect(updated.experiences[0].title).toBe("Updated");
    expect(() => configureArtistExperience({ catalog: updated, artistId: "artist-2", experience: { ...experience, title: "Hijacked" } })).toThrow(/owning artist/);
  });

  it("requires a valid signature and current ownership before issuing a grant", () => {
    const challenge = createChallengeResponse({ wallet: "0xABC", experienceId: "exp-1", nonce: "n1", issuedAt: 100 }).challenge;
    const result = issueMediaGrant({ challenge, signature: "sig", wallet: "0xabc", experience, now: 100, verifySignature: () => true, ownsExperience: () => true });
    expect(result.grant.mediaType).toBe("AUDIO");
    expect(() => issueMediaGrant({ challenge, signature: "sig", wallet: "0xabc", experience, verifySignature: () => false, ownsExperience: () => true })).toThrow(/signature/);
  });

  it("authorizes valid media and records denied requests in the audit log", () => {
    const log = createAuditLog(storage());
    const challenge = createChallengeResponse({ wallet: "0xabc", experienceId: "exp-1", nonce: "n1", issuedAt: 100 }).challenge;
    const { grant } = issueMediaGrant({ challenge, signature: "sig", wallet: "0xabc", experience, now: 100, verifySignature: () => true, ownsExperience: () => true });
    expect(authorizeMediaRequest({ grant, wallet: "0xabc", experienceId: "exp-1", mediaType: "AUDIO", now: 101, auditLog: log }).allowed).toBe(true);
    expect(authorizeMediaRequest({ grant, wallet: "0xdef", experienceId: "exp-1", mediaType: "AUDIO", now: 101, auditLog: log }).allowed).toBe(false);
    expect(log.entries()).toHaveLength(2);
  });

  it("enforces the physical redemption state machine", () => {
    const redemption = createRedemption({ experienceId: "exp-1", wallet: "0xABC" });
    const reserved = transitionRedemption(redemption, REDEMPTION_STATES.RESERVED, { actor: "artist-1" });
    const redeemed = transitionRedemption(reserved, REDEMPTION_STATES.REDEEMED, { actor: "fulfillment" });
    expect(redeemed.state).toBe("REDEEMED");
    expect(() => transitionRedemption(redeemed, REDEMPTION_STATES.AVAILABLE)).toThrow(/Invalid redemption/);
  });
});
