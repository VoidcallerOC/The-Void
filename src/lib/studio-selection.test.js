import { describe, expect, it } from "vitest";
import { resumeOwnedRelease, selectReleaseTemplate } from "./studio-selection.js";

describe("Studio release selection", () => {
  it("loads a public release as a new wallet-owned template without reusing server IDs", () => {
    expect(selectReleaseTemplate({
      artist: { id: "public-artist", name: "Voidcaller", bio: "Metalcore." },
      release: { id: "public-release", artistId: "public-artist", title: "Voidcaller Full EP", description: "The record.", artwork: "/art.png" },
    })).toEqual({
      artistId: "",
      releaseId: "",
      editionId: "",
      selectedReleaseId: "",
      form: {
        releaseTitle: "Voidcaller Full EP",
        releaseDescription: "The record.",
        releaseArtwork: "/art.png",
        trackArtwork: "",
      },
    });
  });

  it("does not carry an owner wallet or public IDs from a catalog record", () => {
    const selected = selectReleaseTemplate({
      artist: { id: "artist-a", name: "A", ownerWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      release: { id: "release-a", title: "A Record" },
    });
    expect(selected.artistId).toBe("");
    expect(selected.releaseId).toBe("");
    expect(selected).not.toHaveProperty("ownerWallet");
  });

  it("never fills artwork with the site's own Voidcaller images", () => {
    const selected = selectReleaseTemplate({ artist: { name: "A" }, release: { title: "No Art" } });
    expect(selected.form.releaseArtwork).toBe("");
    expect(selected.form.trackArtwork).toBe("");
  });

  it("recovers the edition and token without session state", () => {
    const catalog = {
      releases: [{ id: "release-1", artistId: "artist-1", title: "Forgive & Forget", description: "What's done is done", status: "published" }],
      editions: [{ id: "edition-1", releaseId: "release-1", title: "Forgive & Forget", status: "available", supply: "25", tokenIds: ["987654321"], priceWei: "10000000000000000" }],
    };

    expect(resumeOwnedRelease(catalog, "release-1")).toMatchObject({
      published: true,
      releaseId: "release-1",
      editionId: "edition-1",
      tokenId: "987654321",
      form: { quantity: "25", priceWei: "10000000000000000" },
    });
  });

  it("does not claim recovery is possible when the persisted token relationship is absent", () => {
    const catalog = {
      releases: [{ id: "release-1", title: "Unresolved", status: "published" }],
      editions: [{ id: "edition-1", releaseId: "release-1", status: "available", tokenIds: [] }],
    };

    expect(resumeOwnedRelease(catalog, "release-1")).toMatchObject({ published: true, tokenId: "" });
  });
});
