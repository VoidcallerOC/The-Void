import { describe, expect, it } from "vitest";
import { albumSingleCandidates, linkedAlbumSingles, nextAlbumTrackPosition, releaseTypeOf, singleIsComplete } from "./release-types.js";

const catalog = {
  releases: [
    { id: "album", artistId: "a", title: "Album", status: "draft", releaseType: "ALBUM" },
    { id: "s1", artistId: "a", title: "One", status: "published", releaseType: "SINGLE" },
    { id: "s2", artistId: "a", title: "Two", status: "draft", releaseType: "SINGLE" },
    { id: "s3", artistId: "a", title: "Three", status: "draft", releaseType: "SINGLE" },
    { id: "s4", artistId: "b", title: "Other artist", status: "published", releaseType: "SINGLE" },
    { id: "ep", artistId: "a", title: "EP", status: "published", releaseType: "EP" },
  ],
  editions: [{ id: "e3", releaseId: "s3", status: "available" }, { id: "e2", releaseId: "s2", status: "draft" }],
  albumSingles: [{ album_release_id: "album", single_release_id: "s1", track_position: 2 }],
};

describe("release types", () => {
  it("normalizes stored types and keeps untyped legacy releases as EP", () => {
    expect(["single", "Ep", "ALBUM", null, undefined, "", "LP"].map(releaseTypeOf)).toEqual(["SINGLE", "EP", "ALBUM", "EP", "EP", "EP", "EP"]);
  });

  it("treats a single as complete once it is published or has a published edition", () => {
    expect(singleIsComplete(catalog, catalog.releases[1])).toBe(true);
    expect(singleIsComplete(catalog, catalog.releases[2])).toBe(false);
    expect(singleIsComplete(catalog, catalog.releases[3])).toBe(true);
    expect(singleIsComplete(catalog, catalog.releases[5])).toBe(false);
  });

  it("lists linked singles in track order and offers only this artist's unlinked published singles", () => {
    expect(linkedAlbumSingles(catalog, "album")).toEqual([{ singleReleaseId: "s1", trackPosition: 2, title: "One" }]);
    expect(albumSingleCandidates(catalog, catalog.releases[0]).map((release) => release.id)).toEqual(["s3"]);
    expect(nextAlbumTrackPosition(catalog, "album")).toBe(1);
    expect(nextAlbumTrackPosition({ ...catalog, albumSingles: [...catalog.albumSingles, { album_release_id: "album", single_release_id: "s3", track_position: 1 }] }, "album")).toBe(3);
  });
});
