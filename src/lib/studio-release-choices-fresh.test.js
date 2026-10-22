import { describe, expect, it } from "vitest";
import { existingDraftsForTitle, studioReleaseChoices } from "./studio-release-choices.js";

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
});
