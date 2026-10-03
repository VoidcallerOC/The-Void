import { describe, expect, it } from "vitest";
import { editionHasGatedTrack, resumeOwnedRelease } from "./studio-selection.js";

// The Studio catalog API lists editions newest first.
const catalog = {
  releases: [
    { id: "rel-1", artistId: "voidcaller", title: "Forgive & Forget", description: "What's done is done", status: "draft", artwork: "/assets/voidcaller_art_4.png" },
    { id: "rel-live", artistId: "voidcaller", title: "Forgive & Forget", status: "published" },
  ],
  editions: [
    { id: "ed-new", releaseId: "rel-1", title: "Forgive & Forget", status: "draft", tokenIds: [], supply: "25", previewAudio: "", includes: [] },
    { id: "ed-gated", releaseId: "rel-1", title: "Forgive & Forget", status: "draft", tokenIds: [], supply: "50", previewAudio: "ipfs://preview", includes: ["Full track"] },
    { id: "ed-old", releaseId: "rel-1", title: "Forgive & Forget", status: "draft", tokenIds: [], supply: "10", previewAudio: "", includes: [] },
    { id: "ed-live", releaseId: "rel-live", title: "Forgive & Forget", status: "available", tokenIds: ["3"], supply: "25" },
  ],
  experiences: [{ id: "exp-1", editionId: "ed-gated", media: { protected: true } }],
};

describe("resumeOwnedRelease", () => {
  it("keeps the artist's release and the edition holding the gated full track", () => {
    const resumed = resumeOwnedRelease(catalog, "rel-1");
    expect(resumed).toMatchObject({ artistId: "voidcaller", releaseId: "rel-1", editionId: "ed-gated", gated: true });
    expect(resumed.form).toMatchObject({ releaseTitle: "Forgive & Forget", trackPreview: "ipfs://preview", quantity: "50", includes: "Full track", releaseArtwork: "" });
  });

  it("falls back to the newest edition when none is gated yet", () => {
    const resumed = resumeOwnedRelease({ ...catalog, experiences: [] }, "rel-1");
    expect(resumed).toMatchObject({ editionId: "ed-new", gated: false });
  });

  it("refuses a release that is already published on Fuji", () => {
    expect(resumeOwnedRelease(catalog, "rel-live")).toEqual({ published: true, releaseId: "rel-live", title: "Forgive & Forget" });
    const editionOnly = { ...catalog, releases: [{ ...catalog.releases[1], status: "draft" }] };
    expect(resumeOwnedRelease(editionOnly, "rel-live")).toMatchObject({ published: true });
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
