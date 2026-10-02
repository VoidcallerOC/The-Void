import { describe, expect, it } from "vitest";
import { studioArtistChoices, studioReleaseChoices } from "./studio-release-choices.js";

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
});
