import { describe, expect, it } from "vitest";
import { boundReleaseContract, quantityFromSupply, resumeOwnedRelease, selectReleaseTemplate } from "./studio-selection.js";

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

  it("reloads a stored open edition as quantity 0 and does not turn a missing supply into open", () => {
    expect(quantityFromSupply(0)).toBe("0");
    expect(quantityFromSupply("0")).toBe("0");
    expect(quantityFromSupply(null)).toBeUndefined();
    expect(quantityFromSupply(undefined)).toBeUndefined();
    const catalog = {
      releases: [{ id: "release-1", artistId: "artist-1", title: "Open single", status: "draft" }],
      editions: [{ id: "edition-1", releaseId: "release-1", title: "Open single", status: "draft", supply: "0" }],
    };
    expect(resumeOwnedRelease(catalog, "release-1").form.quantity).toBe("0");
    const missing = {
      releases: [{ id: "release-2", artistId: "artist-1", title: "Unset", status: "draft" }],
      editions: [{ id: "edition-2", releaseId: "release-2", title: "Unset", status: "draft", supply: null }],
    };
    expect(resumeOwnedRelease(missing, "release-2").form).not.toHaveProperty("quantity");
  });

  it("carries the persisted release type into a resumed release, EP when absent", () => {
    const catalog = {
      releases: [
        { id: "album", title: "Album", status: "draft", releaseType: "ALBUM" },
        { id: "album-out", title: "Album Out", status: "published", releaseType: "ALBUM" },
        { id: "legacy", title: "Legacy", status: "draft" },
      ],
      editions: [{ id: "edition-out", releaseId: "album-out", status: "available", tokenIds: ["7"] }],
    };
    expect(resumeOwnedRelease(catalog, "album").form.releaseType).toBe("ALBUM");
    expect(resumeOwnedRelease(catalog, "album-out").form.releaseType).toBe("ALBUM");
    expect(resumeOwnedRelease(catalog, "legacy").form.releaseType).toBe("EP");
  });

  it("finds the release contract a release's editions are bound to on the given chain", () => {
    const catalog = {
      editions: [
        { id: "other", releaseId: "release-2", chainId: 43113, contractAddress: "0x2222222222222222222222222222222222222222" },
        { id: "mainnet", releaseId: "release-1", chainId: 43114, contractAddress: "0x3333333333333333333333333333333333333333" },
        { id: "bound", releaseId: "release-1", chainId: 43113, contractAddress: "0x1111111111111111111111111111111111111111", releaseContractAddress: "0x1111111111111111111111111111111111111111" },
      ],
    };
    expect(boundReleaseContract(catalog, "release-1", 43113)).toBe("0x1111111111111111111111111111111111111111");
    expect(boundReleaseContract(catalog, "release-3", 43113)).toBe("");
    expect(boundReleaseContract(catalog, "", 43113)).toBe("");
    expect(boundReleaseContract(null, "release-1", 43113)).toBe("");
  });
});
