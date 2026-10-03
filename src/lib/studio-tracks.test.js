import { describe, expect, it } from "vitest";
import { tracksOnRelease } from "./studio-tracks.js";

const release = { id: "forgive-forget", title: "Forgive & Forget", tracks: [{ title: "Forgive & Forget", tokenId: "7" }] };

describe("tracks on a release", () => {
  it("lists every edition as its own track, not the single track stored on the release", () => {
    const tracks = tracksOnRelease(release, [
      { id: "edition-1", releaseId: "forgive-forget", title: "Forgive & Forget", tokenIds: ["7"] },
      { id: "edition-2", releaseId: "forgive-forget", title: "New Song", tokenIds: ["8"] },
      { id: "edition-other", releaseId: "other-release", title: "Elsewhere", tokenIds: ["1"] },
    ]);
    expect(tracks.map((track) => track.title)).toEqual(["Forgive & Forget", "New Song"]);
    expect(tracks.map((track) => track.tokenId)).toEqual(["7", "8"]);
    expect(new Set(tracks.map((track) => track.editionId)).size).toBe(2);
  });

  it("keeps a newly added edition on the same release and leaves the original token alone", () => {
    const before = tracksOnRelease(release, [
      { id: "edition-1", releaseId: "forgive-forget", title: "Forgive & Forget", tokenIds: ["7"] },
    ]);
    const after = tracksOnRelease(release, [
      { id: "edition-1", releaseId: "forgive-forget", title: "Forgive & Forget", tokenIds: ["7"] },
      { id: "edition-3", releaseId: "forgive-forget", title: "Another Song", tokenIds: [] },
    ]);
    expect(after.find((track) => track.title === "Forgive & Forget")).toMatchObject({ tokenId: "7", editionId: "edition-1" });
    expect(after.find((track) => track.title === "Another Song")).toMatchObject({ editionId: "edition-3", tokenId: "" });
    expect(before).toHaveLength(1);
    expect(after.every((track) => track.editionId === "edition-1" || track.editionId === "edition-3")).toBe(true);
  });

  it("falls back to release tracks only when the release has no editions", () => {
    expect(tracksOnRelease(release, []).map((track) => track.title)).toEqual(["Forgive & Forget"]);
    expect(tracksOnRelease(null, [])).toEqual([]);
  });
});
