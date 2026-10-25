import { afterEach, describe, expect, it, vi } from "vitest";
import { artworkSources, artworkSrc, dedicatedIpfsGateway, ipfsPath, PUBLIC_IPFS_GATEWAY } from "./artwork.js";

const DEDICATED = "https://fuchsia-labour-butterfly-445.mypinata.cloud/ipfs/";
const COVER = "ipfs://bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i";
const GENESIS_GIF = "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif";

afterEach(() => vi.unstubAllEnvs());

describe("artwork sources", () => {
  it("normalizes the dedicated gateway and refuses anything but https", () => {
    expect(dedicatedIpfsGateway("https://x.mypinata.cloud")).toBe("https://x.mypinata.cloud/ipfs/");
    expect(dedicatedIpfsGateway("https://x.mypinata.cloud/ipfs")).toBe("https://x.mypinata.cloud/ipfs/");
    expect(dedicatedIpfsGateway("https://x.mypinata.cloud/ipfs/")).toBe("https://x.mypinata.cloud/ipfs/");
    expect(dedicatedIpfsGateway("http://x.mypinata.cloud/ipfs/")).toBe("");
    expect(dedicatedIpfsGateway("")).toBe("");
    expect(dedicatedIpfsGateway("not a url")).toBe("");
  });

  it("reads the ipfs path from ipfs:// URIs and from gateway URLs, and nothing from site files", () => {
    expect(ipfsPath(COVER, DEDICATED)).toBe(COVER.slice(7));
    expect(ipfsPath(`${PUBLIC_IPFS_GATEWAY}${COVER.slice(7)}`, DEDICATED)).toBe(COVER.slice(7));
    expect(ipfsPath(`${DEDICATED}${COVER.slice(7)}?img-width=800`, DEDICATED)).toBe(COVER.slice(7));
    expect(ipfsPath("/assets/voidcaller_ep_cover.webp", DEDICATED)).toBeNull();
    expect(ipfsPath("https://example.com/a.png", DEDICATED)).toBeNull();
    expect(ipfsPath("", DEDICATED)).toBeNull();
  });

  it("serves a pinned image resized as WebP from the dedicated gateway, then unresized, then the public gateway", () => {
    expect(artworkSources(COVER, { width: 800, gateway: DEDICATED })).toEqual([
      `${DEDICATED}${COVER.slice(7)}?img-width=800&img-format=webp`,
      `${DEDICATED}${COVER.slice(7)}`,
      `${PUBLIC_IPFS_GATEWAY}${COVER.slice(7)}`,
    ]);
    // The same chain from an already-converted public gateway URL (the catalog stores artwork as http).
    expect(artworkSources(`${PUBLIC_IPFS_GATEWAY}${COVER.slice(7)}`, { width: 1200, gateway: DEDICATED })[0]).toBe(`${DEDICATED}${COVER.slice(7)}?img-width=1200&img-format=webp`);
    expect(artworkSrc(COVER, { gateway: DEDICATED })).toBe(`${DEDICATED}${COVER.slice(7)}?img-width=800&img-format=webp`);
  });

  it("keeps a GIF's format when resizing so its animation survives", () => {
    const gif = "ipfs://bafybeigif/anim.gif";
    expect(artworkSources(gif, { width: 640, gateway: DEDICATED })[0]).toBe(`${DEDICATED}bafybeigif/anim.gif?img-width=640`);
  });

  it("sends Genesis media straight to the public gateway: the dedicated gateway refuses content it did not pin", () => {
    expect(artworkSources(GENESIS_GIF, { gateway: DEDICATED })).toEqual([`${PUBLIC_IPFS_GATEWAY}${GENESIS_GIF.slice(7)}`]);
  });

  it("falls back to the public gateway alone when no dedicated gateway is configured", () => {
    expect(artworkSources(COVER, { gateway: "" })).toEqual([`${PUBLIC_IPFS_GATEWAY}${COVER.slice(7)}`]);
    expect(artworkSources(COVER, { width: 0, gateway: DEDICATED })).toEqual([`${DEDICATED}${COVER.slice(7)}`, `${PUBLIC_IPFS_GATEWAY}${COVER.slice(7)}`]);
  });

  it("returns site files and http images unchanged, and nothing for an empty source", () => {
    expect(artworkSources("/assets/voidcaller_ep_cover.webp", { gateway: DEDICATED })).toEqual(["/assets/voidcaller_ep_cover.webp"]);
    expect(artworkSources("https://example.com/a.png", { gateway: DEDICATED })).toEqual(["https://example.com/a.png"]);
    expect(artworkSources("", { gateway: DEDICATED })).toEqual([]);
    expect(artworkSources(null, { gateway: DEDICATED })).toEqual([]);
  });

  it("reads the mainnet build's gateway from the environment", () => {
    vi.stubEnv("VITE_IPFS_GATEWAY", DEDICATED);
    expect(dedicatedIpfsGateway()).toBe(DEDICATED);
    expect(artworkSrc(COVER)).toBe(`${DEDICATED}${COVER.slice(7)}?img-width=800&img-format=webp`);
  });
});
