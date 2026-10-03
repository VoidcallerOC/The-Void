import { describe, expect, it } from "vitest";
import { tokenView } from "./token-view.js";
import { VOIDCALLER_CATALOG } from "../data.js";
import { mapPublishedCatalog } from "./catalog-source.js";

describe("per-track token view", () => {
  const edition = VOIDCALLER_CATALOG.editions[0];
  const release = VOIDCALLER_CATALOG.releases[0];

  it("a legacy track experience shows its own token artwork, not the collection art", () => {
    const experience = VOIDCALLER_CATALOG.experiences.find((item) => item.id === "voidcaller-legacy-track-3");
    const view = tokenView(VOIDCALLER_CATALOG, { edition, release, experience });
    expect(view.name).toBe("Complex");
    expect(String(view.tokenId)).toBe("3");
    expect(view.artwork).toContain("bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif");
    expect(view.artworkSources).toContain("/assets/track-art/ep1-complex.png");
    expect(view.artworkSources).toContain(release.artwork);
    expect(view.artworkSources.indexOf(release.artwork)).toBeGreaterThan(view.artworkSources.indexOf(view.artwork));
  });

  it("the whole-EP experience keeps the collection artwork", () => {
    const experience = VOIDCALLER_CATALOG.experiences.find((item) => item.id === "voidcaller-full-ep");
    const view = tokenView(VOIDCALLER_CATALOG, { edition, release, experience });
    expect(view.token).toBeNull();
    expect(view.artwork).toBe(release.artwork);
  });

  it("a published single-token edition shows its published token metadata", () => {
    const catalog = mapPublishedCatalog({ releases: [{ id: "r", artist_id: "a", title: "Album", release_metadata: { artwork: "/assets/album.png" } }], editions: [{ id: "e", release_id: "r", title: "Album edition", chain_id: 43113, contract_address: "0x82b26da27136935454bdf1e40801190b521b82e5", token_id: "9", token_metadata: { name: "Track Nine", image: "ipfs://bafytrack9art" } }] });
    const view = tokenView(catalog, { edition: catalog.editions[0], release: catalog.releases[0] });
    expect(view.name).toBe("Track Nine");
    expect(view.artwork).toMatch(/\/ipfs\/bafytrack9art$/);
    expect(view.artworkSources).toContain("/assets/album.png");
  });
});

describe("playable track for a token", () => {
  it("a legacy token plays its own song (gated full track for holders, preview otherwise)", async () => {
    const { playableTrackFor } = await import("./token-view.js");
    const token = VOIDCALLER_CATALOG.tokens.find((item) => String(item.tokenId) === "1");
    const track = playableTrackFor(token);
    expect(track.title).toBe("The Hollow");
    expect(track.previewSrc).toBe("/assets/audio-preview/ep1-01-the-hollow-preview.mp3");
    expect(track.protectedMedia).toEqual({ experienceId: "voidcaller-legacy-track-1", mediaType: "AUDIO" });
  });

  it("a published token plays only its public preview", async () => {
    const { playableTrackFor } = await import("./token-view.js");
    const track = playableTrackFor({ id: "e-token-9", editionId: "e", tokenId: "9", name: "Track Nine", metadata: { name: "Track Nine", animationUrl: "ipfs://bafypreviewnine", image: "ipfs://bafyart" } });
    expect(track).toMatchObject({ title: "Track Nine", preview: true });
    expect(track.src).toMatch(/\/ipfs\/bafypreviewnine$/);
    expect(track.protectedMedia).toBeUndefined();
    expect(playableTrackFor({ id: "x", editionId: "e", tokenId: "1", metadata: {} })).toBeNull();
  });
});

describe("experience player title", () => {
  it("names the player after the experience's demo, not the token's song", async () => {
    const { experienceTrackTitle } = await import("./token-view.js");
    expect(experienceTrackTitle({ experience: { title: "Stranger Things" }, tokenTrack: { title: "Forgive & Forget" }, view: { name: "Forgive & Forget" } })).toBe("Stranger Things");
    expect(experienceTrackTitle({ experience: { title: "" }, tokenTrack: { title: "Forgive & Forget" } })).toBe("Forgive & Forget");
    expect(experienceTrackTitle({ view: { name: "Token" } })).toBe("Token");
  });
});
