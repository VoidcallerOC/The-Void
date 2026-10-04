import { describe, expect, it } from "vitest";
import { LEGACY_ALBUM_ID, LEGACY_CHAIN_ID, LEGACY_CONTRACT } from "./legacy-genesis.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { canTakeReleaseOffTheSite, studioArtistChoices, studioReleaseChoices } from "./studio-release-choices.js";

// Mirrors the Studio picker the user reported: real releases buried among
// test profiles, certification runs and repeated "VOIDCALLER" drafts.
const artists = [
  { id: "artist-real", name: "Voidcaller", handle: "voidcaller-7" },
  { id: "artist-alias", name: "Voidcaller", handle: "voidcaller-3" },
  { id: "artist-asdf", name: "asdf", handle: "asdf" },
  { id: "artist-qwe", name: "qwe", handle: "qwe" },
  { id: "artist-wer", name: "wer", handle: "wer" },
];
const releases = [
  { id: "r-forgive", artistId: "artist-real", title: "Forgive & Forget", status: "draft" },
  { id: "r-e2e", artistId: "artist-real", title: "Marketplace Fuji E2E Test", status: "draft" },
  { id: "r-cert-1", artistId: "artist-wer", title: "PINATA CERTIFICATION 2026-09-27", status: "published" },
  { id: "r-vc-draft-1", artistId: "artist-real", title: "VOIDCALLER", status: "draft" },
  { id: "r-vc-published", artistId: "artist-alias", title: "VOIDCALLER", status: "published" },
  { id: "r-cert-2", artistId: "artist-real", title: "PINATA CERTIFICATION 2026-09-27", status: "draft" },
  { id: "r-asdf", artistId: "artist-asdf", title: "Anything", status: "draft" },
  { id: "r-vc-draft-2", artistId: "artist-real", title: "voidcaller ", status: "draft" },
];

describe("Studio release picker", () => {
  it("hides test/certification records and collapses duplicate titles to the published one", () => {
    const ids = studioReleaseChoices({ releases, artists, editions: [] }).map((record) => record.release.id);
    expect(ids).toEqual(["r-forgive", "r-vc-published"]);
  });

  it("prefers a draft that has editions over an empty duplicate", () => {
    const ids = studioReleaseChoices({ releases: releases.filter((r) => r.id !== "r-vc-published"), artists, editions: [{ releaseId: "r-vc-draft-2" }] }).map((record) => record.release.id);
    expect(ids).toEqual(["r-forgive", "r-vc-draft-2"]);
  });

  it("never empties the picker when every record looks like a test", () => {
    expect(studioReleaseChoices({ releases: [releases[2]], artists }).map((record) => record.release.id)).toEqual(["r-cert-1"]);
  });

  it("drops test profiles from 'Publishing as' unless they are all there is", () => {
    expect(studioArtistChoices(artists).map((artist) => artist.id)).toEqual(["artist-real", "artist-alias"]);
    expect(studioArtistChoices([artists[2]]).map((artist) => artist.id)).toEqual(["artist-asdf"]);
  });

  it("never offers archived duplicates, leaving the live release", () => {
    const artists = [{ id: "voidcaller", name: "Voidcaller" }];
    const releases = [
      { id: "ff-18", artistId: "voidcaller", title: "Forgive & Forget", status: "published" },
      { id: "ff-17", artistId: "voidcaller", title: "Forgive & Forget", status: "archived" },
      { id: "ff-13", artistId: "voidcaller", title: "Forgive & Forget", status: "archived" },
    ];
    expect(studioReleaseChoices({ releases, artists, editions: [] }).map(({ release }) => release.id)).toEqual(["ff-18"]);
    expect(studioReleaseChoices({ releases: releases.slice(1), artists, editions: [] })).toEqual([]);
  });

  it("hides an unpublished release when this artist already archived that title", () => {
    const artists = [
      { id: "voidcaller", name: "VOIDCALLER" },
      { id: "voidcaller-alias", name: "voidcaller" },
      { id: "other", name: "Other Artist" },
    ];
    const releases = [
      { id: "ff-draft", artistId: "voidcaller", title: "Forgive & Forget", status: "draft" },
      { id: "ff-alias", artistId: "voidcaller-alias", title: "forgive & forget ", status: "draft" },
      { id: "ff-archived", artistId: "VOIDCALLER", title: "FORGIVE & FORGET", status: "Archived" },
      { id: "voidcaller-legacy-genesis", artistId: "voidcaller", title: "VOIDCALLER", status: "published" },
      { id: "ff-other", artistId: "other", title: "Forgive & Forget", status: "draft" },
    ];
    expect(studioReleaseChoices({ releases, artists, editions: [] }).map(({ release }) => release.id)).toEqual([
      "voidcaller-legacy-genesis",
      "ff-other",
    ]);
  });

  it("treats ARCHIVED as archived and does not fall back to it when nothing live remains", () => {
    const artists = [{ id: "voidcaller", name: "Voidcaller" }, { id: "e2e", name: "E2E" }];
    const releases = [
      { id: "ff-upper", artistId: "voidcaller", title: "Forgive & Forget", status: "ARCHIVED" },
      { id: "ff-mixed", artistId: "voidcaller", title: "Forgive & Forget", status: "Archived" },
      { id: "e2e-only", artistId: "e2e", title: "Marketplace Fuji E2E Test", status: "draft" },
    ];
    expect(studioReleaseChoices({ releases, artists, editions: [] }).map(({ release }) => release.id)).toEqual(["e2e-only"]);
    expect(studioReleaseChoices({
      releases: [{ id: "ff-only", artistId: "voidcaller", title: "Forgive & Forget", status: "ARCHIVED" }],
      artists: [{ id: "voidcaller", name: "Voidcaller" }],
      editions: [],
    })).toEqual([]);
  });

  it("hides a withdrawn published history row while keeping a valid same-title release selectable", () => {
    const withdrawn = {
      id: "release-1b4a2d71-218f-47a2-afde-cd5171909ace",
      artistId: "voidcaller",
      title: "Forgive & Forget",
      status: "published",
    };
    const fresh = {
      id: "release-fresh-forgive-forget",
      artistId: "voidcaller",
      title: "Forgive & Forget",
      status: "published",
    };
    const choices = studioReleaseChoices({
      releases: [withdrawn, fresh],
      artists: [{ id: "voidcaller", name: "Voidcaller" }],
      editions: [],
    });
    expect(choices.map(({ release }) => release.id)).toEqual(["release-fresh-forgive-forget"]);
  });
});

describe("Take this off the site", () => {
  const legacyEdition = { releaseId: LEGACY_ALBUM_ID, chainId: LEGACY_CHAIN_ID, contractAddress: LEGACY_CONTRACT, status: "minted", tokenIds: ["0"] };
  const fujiMintable = { releaseId: "fuji-voidcaller", chainId: FUJI_RELEASE_CONFIG.chainId, contractAddress: FUJI_RELEASE_CONFIG.contractAddress, status: "available", tokenIds: ["9"] };
  const notMintableYet = { releaseId: "fuji-pending", chainId: FUJI_RELEASE_CONFIG.chainId, contractAddress: FUJI_RELEASE_CONFIG.contractAddress, status: "draft" };

  it("shows the button only for a published release that is not mintable yet", () => {
    const editions = [legacyEdition, fujiMintable, notMintableYet];
    expect(canTakeReleaseOffTheSite({ id: LEGACY_ALBUM_ID, title: "VOIDCALLER", status: "published" }, editions)).toBe(false);
    expect(canTakeReleaseOffTheSite({ id: "other", slug: LEGACY_ALBUM_ID, title: "Something else", status: "PUBLISHED" }, editions)).toBe(false);
    expect(canTakeReleaseOffTheSite({ id: "renamed-legacy", title: "Chapter", status: "published" }, [{ ...legacyEdition, releaseId: "renamed-legacy" }])).toBe(false);
    expect(canTakeReleaseOffTheSite({ id: "fuji-voidcaller", slug: "voidcaller", title: "VOIDCALLER", status: "published" }, editions)).toBe(false);
    expect(canTakeReleaseOffTheSite({ id: "fuji-sale", title: "Open sale", status: "published" }, [{ releaseId: "fuji-sale", status: "draft", primarySale: true }])).toBe(false);
    expect(canTakeReleaseOffTheSite({ id: "fuji-pending", title: "Not out yet", status: "published" }, editions)).toBe(true);
    expect(canTakeReleaseOffTheSite({ id: "ff-18", title: "Forgive & Forget", status: "published" }, editions)).toBe(true);
    expect(canTakeReleaseOffTheSite({ id: "ff-draft", title: "Forgive & Forget", status: "draft" }, [{ releaseId: "ff-draft", status: "draft", tokenIds: ["4"] }])).toBe(false);
  });
});
