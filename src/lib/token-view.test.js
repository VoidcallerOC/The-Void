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
    expect(view.artworkSources.at(-1)).toBe(release.artwork);
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
