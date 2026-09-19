import { describe, expect, it } from "vitest";
import { selectReleaseTemplate } from "./studio-selection.js";

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
        artistName: "Voidcaller",
        artistBio: "Metalcore.",
        releaseTitle: "Voidcaller Full EP",
        releaseDescription: "The record.",
        releaseArtwork: "/art.png",
        trackArtwork: "/art.png",
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
});
