import { describe, expect, it } from "vitest";
import {
  STUDIO_ADMIN_DEPLOYER_WALLET,
  STUDIO_PLATFORM_ARTIST_WALLET,
  isStudioAdminDeployerWallet,
  isVoidcallerArtistProfile,
  studioCatalogForConnectedWallet,
} from "./studio-wallet-catalog.js";

const admin = STUDIO_ADMIN_DEPLOYER_WALLET;
const artistWallet = STUDIO_PLATFORM_ARTIST_WALLET;

const catalog = {
  artists: [
    { id: "voidcaller", name: "Voidcaller", handle: "voidcaller" },
    { id: "artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495", name: "Voidcaller", handle: "voidcaller-5" },
    { id: "artist-other", name: "Other Band", handle: "other-band" },
  ],
  releases: [
    { id: "ff-voidcaller-5", artistId: "artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495", title: "Forgive & Forget", status: "draft" },
    { id: "legacy", artistId: "voidcaller", title: "VOIDCALLER", status: "published" },
    { id: "other-release", artistId: "artist-other", title: "Other Song", status: "draft" },
  ],
  editions: [
    { id: "ed-ff", releaseId: "ff-voidcaller-5", title: "Forgive & Forget" },
    { id: "ed-other", releaseId: "other-release", title: "Other Song" },
  ],
  experiences: [
    { id: "xp-ff", artistId: "artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495", releaseId: "ff-voidcaller-5", editionId: "ed-ff" },
    { id: "xp-other", artistId: "artist-other", releaseId: "other-release", editionId: "ed-other" },
  ],
  tokens: [
    { id: "tok-ff", editionId: "ed-ff" },
    { id: "tok-other", editionId: "ed-other" },
  ],
};

describe("Studio catalog for connected wallet", () => {
  it("pins the admin deployer and platform artist wallets", () => {
    expect(admin).toBe("0xabd3746e8b852f55be52fc44fab6cab908b1c174");
    expect(artistWallet).toBe("0x284c09a7cc187e096cbbdc88d99defe6df32180a");
    expect(isStudioAdminDeployerWallet(admin)).toBe(true);
    expect(isStudioAdminDeployerWallet(artistWallet)).toBe(false);
  });

  it("treats voidcaller and voidcaller-5 as Voidcaller artist profiles", () => {
    expect(isVoidcallerArtistProfile(catalog.artists[0])).toBe(true);
    expect(isVoidcallerArtistProfile(catalog.artists[1])).toBe(true);
    expect(isVoidcallerArtistProfile(catalog.artists[2])).toBe(false);
  });

  it("hides Voidcaller Forgive & Forget from the admin deployer wallet", () => {
    const filtered = studioCatalogForConnectedWallet(catalog, admin);
    expect(filtered.artists.map((artist) => artist.id)).toEqual(["artist-other"]);
    expect(filtered.releases.map((release) => release.id)).toEqual(["other-release"]);
    expect(filtered.releases.some((release) => release.title === "Forgive & Forget")).toBe(false);
    expect(filtered.editions.map((edition) => edition.id)).toEqual(["ed-other"]);
    expect(filtered.experiences.map((experience) => experience.id)).toEqual(["xp-other"]);
    expect(filtered.tokens.map((token) => token.id)).toEqual(["tok-other"]);
  });

  it("leaves the artist wallet catalog untouched so Forgive & Forget still shows", () => {
    expect(studioCatalogForConnectedWallet(catalog, artistWallet)).toEqual(catalog);
  });

  it("leaves any non-admin wallet catalog untouched", () => {
    expect(studioCatalogForConnectedWallet(catalog, "0x1111111111111111111111111111111111111111")).toEqual(catalog);
  });

  it("accepts snake_case catalog rows from GET /studio/catalog", () => {
    const raw = {
      artists: [{ id: "artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495", display_name: "Voidcaller", slug: "voidcaller-5" }],
      releases: [{ id: "ff", artist_id: "artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495", title: "Forgive & Forget" }],
      editions: [{ id: "ed", release_id: "ff", artist_id: "artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495" }],
      experiences: [],
      tokens: [],
    };
    expect(studioCatalogForConnectedWallet(raw, admin).releases).toEqual([]);
    expect(studioCatalogForConnectedWallet(raw, artistWallet).releases).toHaveLength(1);
  });
});
