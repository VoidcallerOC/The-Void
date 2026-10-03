import { describe, expect, it } from "vitest";
import { editionHasGatedTrack, resumeOwnedRelease } from "./studio-selection.js";

const catalog = {
  releases: [{ id: "rel-1", artistId: "voidcaller", title: "Forgive & Forget", description: "What's done is done", artwork: "/assets/voidcaller_art_4.png" }],
  editions: [
    { id: "ed-old", releaseId: "rel-1", title: "Forgive & Forget", status: "draft", tokenIds: ["1"], supply: "25", previewAudio: "", includes: [] },
    { id: "ed-gated", releaseId: "rel-1", title: "Forgive & Forget", status: "draft", tokenIds: ["2"], supply: "50", previewAudio: "ipfs://preview", includes: ["Full track"] },
    { id: "ed-live", releaseId: "rel-1", title: "Forgive & Forget", status: "available", tokenIds: ["3"], supply: "25", previewAudio: "", includes: [] },
  ],
  experiences: [{ id: "exp-1", editionId: "ed-gated", media: { protected: true } }],
};

describe("resumeOwnedRelease", () => {
  it("keeps the artist's release and the edition holding the gated full track", () => {
    const resumed = resumeOwnedRelease(catalog, "rel-1");
    expect(resumed).toMatchObject({ artistId: "voidcaller", releaseId: "rel-1", editionId: "ed-gated", gated: true });
    expect(resumed.form).toMatchObject({ releaseTitle: "Forgive & Forget", trackPreview: "ipfs://preview", quantity: "50", includes: "Full track", releaseArtwork: "" });
  });

  it("never resumes an edition already published on-chain", () => {
    const resumed = resumeOwnedRelease({ ...catalog, experiences: [] }, "rel-1");
    expect(resumed.editionId).toBe("ed-gated");
    expect(resumed.gated).toBe(false);
  });

  it("returns null for a release the wallet does not own", () => {
    expect(resumeOwnedRelease(catalog, "someone-else")).toBeNull();
  });

  it("only counts protected experiences as a gated track", () => {
    expect(editionHasGatedTrack(catalog, "ed-gated")).toBe(true);
    expect(editionHasGatedTrack({ experiences: [{ editionId: "ed-old", media: {} }] }, "ed-old")).toBe(false);
    expect(editionHasGatedTrack(catalog, "")).toBe(false);
  });
});
