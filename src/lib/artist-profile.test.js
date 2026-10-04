import { describe, expect, it } from "vitest";
import { portfolioImageSrc, profileFormFromRow, profilePayload, profileSocials, safeHttpUrl } from "./artist-profile.js";

describe("artist profile", () => {
  it("only ever allows http(s) links", () => {
    expect(safeHttpUrl("https://x.com/voidcaller")).toBe("https://x.com/voidcaller");
    expect(safeHttpUrl("javascript:alert(1)")).toBe("");
    expect(safeHttpUrl("data:text/html,<script>")).toBe("");
    expect(safeHttpUrl("x.com/voidcaller")).toBe("");
    expect(safeHttpUrl("")).toBe("");
  });

  it("builds public socials from stored links and drops unsafe ones", () => {
    expect(profileSocials({ x: "https://x.com/vc", instagram: "javascript:alert(1)", discord: "https://discord.gg/abc" }, "https://voidcaller.example")).toEqual([
      { name: "Website", href: "https://voidcaller.example/" },
      { name: "X", href: "https://x.com/vc" },
      { name: "Discord", href: "https://discord.gg/abc" },
    ]);
    expect(profileSocials(null)).toEqual([]);
  });

  it("prefills the editor from the owner's studio catalog row", () => {
    expect(profileFormFromRow({ display_name: "Voidcaller", bio: "Metalcore.", website_url: "https://v.example", social_links: { x: "https://x.com/vc" }, profile_metadata: { profileArtwork: "ipfs://avatar", banner: "ipfs://banner" } })).toEqual({
      name: "Voidcaller", bio: "Metalcore.", avatar: "ipfs://avatar", banner: "ipfs://banner",
      links: { website: "https://v.example", x: "https://x.com/vc", instagram: "", discord: "" },
    });
  });

  it("produces the update payload, keeps unrelated profile metadata, and rejects bad input", () => {
    const form = { name: " Voidcaller ", bio: "Metalcore.", avatar: "ipfs://avatar", banner: "", links: { website: "https://v.example", x: "https://x.com/vc", instagram: "", discord: "" } };
    expect(profilePayload(form, { legacyField: 1, banner: "ipfs://old" })).toEqual({
      name: "Voidcaller", bio: "Metalcore.", websiteUrl: "https://v.example/", links: { x: "https://x.com/vc" }, profileArtwork: "ipfs://avatar", profileMetadata: { legacyField: 1 },
    });
    expect(() => profilePayload({ ...form, name: "  " })).toThrow(/name is required/);
    expect(() => profilePayload({ ...form, links: { ...form.links, instagram: "javascript:alert(1)" } })).toThrow(/Instagram must be a full http\(s\) link/);
  });

  it("serves a new portfolio image from the site and still resolves an older ipfs URI", () => {
    expect(portfolioImageSrc("/assets/artist-portfolio/artist-portfolio-0123456789abcdef.png")).toBe("/api/artists/portfolio/artist-portfolio-0123456789abcdef.png");
    expect(portfolioImageSrc("ipfs://bafyavatar")).toBe("https://gateway.pinata.cloud/ipfs/bafyavatar");
    expect(portfolioImageSrc("/assets/voidcaller_art_4.png")).toBe("/assets/voidcaller_art_4.png");
    expect(portfolioImageSrc("")).toBe("");
  });
});

