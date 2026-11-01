import { describe, expect, it } from "vitest";
import { VOIDCALLER_CATALOG } from "../data.js";
import { LEGACY_TOKEN_DESCRIPTIONS, legacyExperienceId } from "./legacy-genesis.js";
import { experienceRowMetadata } from "./experience-metadata.js";

const edition = VOIDCALLER_CATALOG.editions.find((item) => item.id === "voidcaller-chapter-i");
const experience = (id) => VOIDCALLER_CATALOG.experiences.find((item) => item.id === id);

describe("experience row metadata", () => {
  it("reads a song row from its own token: id, length, on-chain description and art, contract and chain", () => {
    const meta = experienceRowMetadata(VOIDCALLER_CATALOG, experience(legacyExperienceId(1)), edition);
    expect(meta).toMatchObject({ kind: "track", tokenId: "1", duration: "3:57", chainId: 43114, contract: edition.contractAddress });
    expect(meta.description).toBe(LEGACY_TOKEN_DESCRIPTIONS[1].trim());
    expect(meta.description).toMatch(/LYRICS:/);
    expect(meta.artworkSources[0]).toMatch(/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP\/1\.gif$/);
    expect(meta.artworkSources).toContain("/assets/track-art/ep1-the-hollow.png");
  });

  it("shows no description for a token whose metadata has none", () => {
    expect(experienceRowMetadata(VOIDCALLER_CATALOG, experience(legacyExperienceId(3)), edition).description).toBe("");
  });

  it("summarizes the whole-record row from the edition's tracks", () => {
    expect(experienceRowMetadata(VOIDCALLER_CATALOG, experience("voidcaller-full-ep"), edition)).toMatchObject({ kind: "record", trackCount: 4, totalDuration: "18:11", tokenIds: ["0", "1", "2", "3"], chainId: 43114 });
  });

  it("returns nothing for a record row without an edition to read", () => {
    expect(experienceRowMetadata(VOIDCALLER_CATALOG, experience("voidcaller-full-ep"), null)).toBeNull();
  });
});
