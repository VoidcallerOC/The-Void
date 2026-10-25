// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EditionCard, SecondaryListingCard } from "./MarketplaceCards.jsx";
import { createCatalog, createEdition, createRelease, createToken } from "../domain/models.js";
import { PUBLIC_IPFS_GATEWAY } from "../lib/artwork.js";

const DEDICATED = "https://fuchsia-labour-butterfly-445.mypinata.cloud/ipfs/";
const CID = "bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i";
const release = createRelease({ id: "release-ff", artistId: "voidcaller", title: "Forgive & Forget", artwork: "/assets/voidcaller_art_4.png" });
// The catalog stores artwork as an http URL of the public gateway (catalog-source mapPublishedCatalog).
const edition = createEdition({ id: "edition-ff", releaseId: "release-ff", title: "Forgive & Forget", chainId: 43114, contractAddress: "0xf0c091a159de16cf0f306b2b61d37685ec5a830e", artwork: `${PUBLIC_IPFS_GATEWAY}${CID}`, tokenIds: ["1"] });
const token = createToken({ id: "edition-ff-token-1", editionId: "edition-ff", tokenId: "1", name: "Forgive & Forget", metadata: { name: "Forgive & Forget", image: `ipfs://${CID}`, description: "", animationUrl: "" } });
const catalog = createCatalog({ artists: [], releases: [release], editions: [edition], tokens: [token], experiences: [] });
const item = { edition, release, artist: { name: "Voidcaller" }, primary: { availability: "available", href: "/edition/edition-ff" }, chain: { id: 43114, name: "Avalanche C-Chain" }, experiences: [] };
const listing = { id: "l1", listingId: "1", authority: "INDEXED", status: "ACTIVE", tokenId: "1", amount: "1", price: "1000000000000000000", seller: "0x1111111111111111111111111111111111111111" };

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("card artwork delivery", () => {
  it("renders the edition cover from the dedicated gateway, resized and lazy, when the build names one", () => {
    vi.stubEnv("VITE_IPFS_GATEWAY", DEDICATED);
    const { container } = render(<MemoryRouter><EditionCard item={item} /></MemoryRouter>);
    const img = container.querySelector("img");
    expect(img.getAttribute("src")).toBe(`${DEDICATED}${CID}?img-width=800&img-format=webp`);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });

  it("falls back through the unresized dedicated copy to the public gateway when a source fails to load", () => {
    vi.stubEnv("VITE_IPFS_GATEWAY", DEDICATED);
    const { container } = render(<MemoryRouter><EditionCard item={item} /></MemoryRouter>);
    const img = () => container.querySelector("img");
    fireEvent.error(img());
    expect(img().getAttribute("src")).toBe(`${DEDICATED}${CID}`);
    fireEvent.error(img());
    expect(img().getAttribute("src")).toBe(`${PUBLIC_IPFS_GATEWAY}${CID}`);
    fireEvent.error(img());
    expect(img().getAttribute("src")).toBe(`${PUBLIC_IPFS_GATEWAY}${CID}`);
  });

  it("uses the public gateway alone when no dedicated gateway is configured", () => {
    vi.stubEnv("VITE_IPFS_GATEWAY", "");
    const { container } = render(<MemoryRouter><EditionCard item={item} /></MemoryRouter>);
    expect(container.querySelector("img").getAttribute("src")).toBe(`${PUBLIC_IPFS_GATEWAY}${CID}`);
  });

  it("leads a listing card with the listed token's own image through the dedicated gateway, then the edition art", () => {
    vi.stubEnv("VITE_IPFS_GATEWAY", DEDICATED);
    // A distinct edition cover (site file) so the token image and the edition art can be told apart.
    const siteEdition = createEdition({ ...edition, artwork: "/assets/voidcaller_art_4.png" });
    const siteCatalog = createCatalog({ ...catalog, editions: [siteEdition] });
    const { container } = render(<MemoryRouter><SecondaryListingCard item={{ ...item, edition: siteEdition }} listings={[listing]} catalog={siteCatalog} /></MemoryRouter>);
    const img = () => container.querySelector("img");
    expect(img().getAttribute("src")).toBe(`${DEDICATED}${CID}?img-width=800&img-format=webp`);
    expect(img().getAttribute("alt")).toMatch(/token #1 artwork/);
    fireEvent.error(img()); fireEvent.error(img()); fireEvent.error(img());
    // Every gateway candidate for the token image failed: the edition's own site-file artwork is next, so the card
    // keeps showing a cover rather than a broken image, and stops claiming to show the token's own art.
    expect(img().getAttribute("src")).toBe("/assets/voidcaller_art_4.png");
    expect(img().getAttribute("alt")).toBe("Forgive & Forget edition artwork");
  });
});
