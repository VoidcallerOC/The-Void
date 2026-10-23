import { describe, expect, it } from "vitest";
import { existingDraftsForTitle, studioReleaseChoices } from "./studio-release-choices.js";
import { mapPublishedCatalog } from "./catalog-source.js";

const artists = [{ id: "voidcaller", name: "Voidcaller" }];
const retired = { id: "release-cd9c689c-8b90-41ee-b4e4-0124a63d6819", artistId: "voidcaller", title: "Forgive & Forget", status: "ARCHIVED" };
const fresh = { id: "release-fresh", artistId: "voidcaller", title: "Forgive & Forget", status: "DRAFT" };
const deployed = { release_id: "release-fresh", status: "DEPLOYED", release_contract_address: "0x2222222222222222222222222222222222222222" };
const ids = (releases, releaseBindings = []) => studioReleaseChoices({ releases, artists, releaseBindings }).map(({ release }) => release.id);

describe("the retired broken release and a completely new release", () => {
  it("never offers the retired release, with or without its own deployed clone", () => {
    expect(ids([retired])).not.toContain(retired.id);
    expect(ids([retired], [{ ...deployed, release_id: retired.id }])).not.toContain(retired.id);
  });

  it("offers a new same-title release once its own clone is deployed, and never the retired one", () => {
    expect(ids([retired, fresh], [deployed])).toContain("release-fresh");
    expect(ids([retired, fresh], [deployed])).not.toContain(retired.id);
  });

  it("does not resume the retired release as a draft when the artist starts a release with the same title", () => {
    expect(existingDraftsForTitle([retired], { artistId: "voidcaller", title: "forgive & forget" })).toEqual([]);
    expect(existingDraftsForTitle([retired, fresh], { artistId: "voidcaller", title: "forgive & forget" }).map((release) => release.id)).toEqual(["release-fresh"]);
  });

  it("offers a brand-new draft that reuses a retired title, but not a leftover draft that predates the retirement", () => {
    const archived = { ...retired, updatedAt: "2026-10-22T16:00:00.000Z" };
    const leftover = { ...fresh, id: "release-leftover", updatedAt: "2026-10-22T15:00:00.000Z" };
    const created = { ...fresh, id: "release-created-after", updatedAt: "2026-10-22T17:00:00.000Z" };
    expect(ids([archived, leftover])).toEqual([]);
    expect(ids([archived, leftover, created])).toEqual(["release-created-after"]);
    // Without timestamps the previous behaviour holds: an unpublished same-title release is a leftover.
    expect(ids([retired, fresh])).toEqual([]);
  });
});

describe("the Studio catalog API rows drive the picker", () => {
  const apiRows = (withUpdatedAt) => [
    { id: "release-old", artist_id: "voidcaller", slug: "forgive-forget-5", title: "Forgive & Forget", description: null, status: "ARCHIVED", release_metadata: {}, ...(withUpdatedAt ? { updated_at: "2026-10-23T00:58:23.711Z" } : {}) },
    { id: "release-new", artist_id: "voidcaller", slug: "forgive-forget-6", title: "Forgive & Forget", description: null, status: "DRAFT", release_metadata: {}, ...(withUpdatedAt ? { updated_at: "2026-10-23T12:10:23.738Z" } : {}) },
  ];
  const offered = (rows) => studioReleaseChoices({ ...mapPublishedCatalog({ artists: [{ id: "voidcaller", display_name: "Voidcaller", slug: "voidcaller" }], releases: rows }), releaseBindings: [] }).map(({ release }) => release.id);

  it("offers the new draft when the API returns updated_at, so it can be reopened after a reload", () => {
    expect(offered(apiRows(true))).toEqual(["release-new"]);
  });

  it("without updated_at a same-title draft is treated as a leftover (why the API must send it)", () => {
    expect(offered(apiRows(false))).toEqual([]);
  });
});

describe("the real Forgive & Forget catalog: one active release", () => {
  const ff = (id, status, extra = {}) => ({ id, artistId: "voidcaller", title: "Forgive & Forget", status, ...extra });
  const archivedAt = "2026-10-23T00:58:23.711Z";
  const releases = [
    ff("release-83611741", "ARCHIVED", { updatedAt: "2026-10-22T00:54:22.855Z" }),
    ff("release-273f5476", "ARCHIVED", { updatedAt: "2026-10-22T09:42:49.933Z" }),
    ff("release-cd9c689c", "ARCHIVED", { updatedAt: "2026-10-22T13:52:48.262Z" }),
    ff("release-84f72628", "ARCHIVED", { updatedAt: "2026-10-22T16:42:32.527Z" }),
    ff("release-88dbe3b8", "ARCHIVED", { updatedAt: "2026-10-22T19:12:02.404Z" }),
    ff("release-7bc53df7", "ARCHIVED", { updatedAt: archivedAt }),
    ff("release-e3743294", "DRAFT", { updatedAt: "2026-10-23T13:36:34.105Z" }),
    { id: "release-voidcaller-ep", artistId: "voidcaller", title: "VOIDCALLER", status: "PUBLISHED", updatedAt: "2026-09-20T00:00:00.000Z" },
  ];
  const bound = [{ release_id: "release-e3743294", status: "DEPLOYED", release_contract_address: "0xf9c48a2bbceba7577ff17a2eed20fcef70ea480d" }];

  it("offers only forgive-forget-6 among the Forgive & Forget records, and leaves other releases alone", () => {
    expect(ids(releases, bound)).toEqual(["release-e3743294", "release-voidcaller-ep"]);
  });

  it("still offers forgive-forget-6 before its contract is bound, because it changed after the last retirement", () => {
    expect(ids(releases)).toEqual(["release-e3743294", "release-voidcaller-ep"]);
  });

  it("never offers an archived record, even a retired one with a holder", () => {
    for (const id of ["release-83611741", "release-273f5476", "release-cd9c689c", "release-84f72628", "release-88dbe3b8", "release-7bc53df7"]) expect(ids(releases, bound)).not.toContain(id);
  });
});

