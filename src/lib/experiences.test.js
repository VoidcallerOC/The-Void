import { describe, expect, it } from "vitest";
import { createEdition, createExperience, createRequirement, EXPERIENCE_TYPES } from "../domain/models.js";
import { canAccessExperience, resolveExperienceAccess } from "./collection.js";
import { createAuthorizationGrant, grantAllows } from "./media-auth.js";

const wallet = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222";
const owned = [{ wallet, contract, tokenId: "1", amount: 2, chain: { id: 43114 } }];
const requirement = createRequirement({ contract, tokenIds: [1], minAmount: 1, chainId: 43114 });

describe("Phase 6 experiences", () => {
  it("supports the complete conceptual experience type set", () => {
    expect(Object.values(EXPERIENCE_TYPES)).toEqual(expect.arrayContaining(["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "ARTWORK", "LYRICS", "DEMO", "LIVE_RECORDING", "TICKET", "VIP_ACCESS", "DISCOUNT", "PHYSICAL_REDEMPTION"]));
  });
  it("associates multiple experiences with an edition without token-id UI rules", () => {
    const edition = createEdition({ id: "archive", releaseId: "r", title: "Archive", experienceIds: ["audio", "stems", "live"], tier: "archive", valueProposition: "Album, demos, stems, and a live recording" });
    const experiences = ["AUDIO", "STEMS", "LIVE_RECORDING"].map((experienceType, index) => createExperience({ id: edition.experienceIds[index], experienceType, title: experienceType, requirements: [requirement] }));
    expect(edition.experienceIds).toHaveLength(3);
    expect(experiences.every((experience) => canAccessExperience(experience, owned))).toBe(true);
  });
  it("explains locked audio and download access for an unauthorized wallet", () => {
    const experience = createExperience({ id: "demo", experienceType: EXPERIENCE_TYPES.DEMO, title: "Demos", requirements: [requirement], media: { protected: true } });
    expect(resolveExperienceAccess(experience, []).label).toBe("LOCKED");
    expect(resolveExperienceAccess(experience, []).reason).toMatch(/required edition/i);
  });
  it("binds protected grants to wallet, experience, type, and expiry", () => {
    const grant = createAuthorizationGrant({ wallet, experienceId: "stems", grantId: "opaque", mediaType: "STEMS", issuedAt: 100, ttlSeconds: 300 });
    expect(grantAllows(grant, { wallet, experienceId: "stems", mediaType: "STEMS", now: 399 })).toBe(true);
    expect(grantAllows(grant, { wallet, experienceId: "stems", mediaType: "STEMS", now: 400 })).toBe(false);
    expect(grantAllows(grant, { wallet, experienceId: "stems", mediaType: "DOWNLOAD", now: 200 })).toBe(false);
  });
});
