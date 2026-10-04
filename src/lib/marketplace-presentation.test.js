import { describe, expect, it } from "vitest";
import { marketplaceHeroImage, validateMarketplaceArtwork } from "./marketplace-presentation.js";

describe("marketplace hero artwork", () => {
  it("accepts ipfs, https and /assets references", () => {
    expect(validateMarketplaceArtwork("ipfs://bafybeidedfcwz6qykwzqoqcs37zsqbjj3wpadyytee4didw2ocnur7veni")).toMatchObject({ ok: true });
    expect(validateMarketplaceArtwork("https://example.com/hero.png")).toEqual({ ok: true, value: "https://example.com/hero.png" });
    expect(validateMarketplaceArtwork("/assets/voidcaller_art_6.png")).toEqual({ ok: true, value: "/assets/voidcaller_art_6.png" });
  });

  it("treats empty as cleared", () => {
    expect(validateMarketplaceArtwork("")).toEqual({ ok: true, value: null });
    expect(validateMarketplaceArtwork(null)).toEqual({ ok: true, value: null });
  });

  it("rejects unsafe or unsupported references", () => {
    for (const bad of ["javascript:alert(1)", "http://example.com/a.png", "data:image/png;base64,AAA", "https://x.com/a.png) , url(evil", "/assets/../secret.txt", "ftp://x/a.png"]) {
      expect(validateMarketplaceArtwork(bad).ok).toBe(false);
    }
  });

  it("resolves only the configured artwork, with no fallback image", () => {
    expect(marketplaceHeroImage({ heroArtwork: "ipfs://bafybeidedfcwz6qykwzqoqcs37zsqbjj3wpadyytee4didw2ocnur7veni" })).toBe("https://gateway.pinata.cloud/ipfs/bafybeidedfcwz6qykwzqoqcs37zsqbjj3wpadyytee4didw2ocnur7veni");
    expect(marketplaceHeroImage({ heroArtwork: "/assets/voidcaller_art_6.png" })).toBe("/assets/voidcaller_art_6.png");
    expect(marketplaceHeroImage({ heroArtwork: "/assets/marketplace-heroes/marketplace-hero-0123456789abcdef.jpg" })).toBe("/api/marketplace/heroes/marketplace-hero-0123456789abcdef.jpg");
    expect(marketplaceHeroImage({ heroArtwork: null })).toBeNull();
    expect(marketplaceHeroImage(null)).toBeNull();
  });
});
