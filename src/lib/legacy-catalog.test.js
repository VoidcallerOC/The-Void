import { describe, expect, it } from "vitest";
import { VC_DATA, VOIDCALLER_CATALOG } from "../data.js";
import { createCatalog } from "../domain/models.js";
import { mapPublishedCatalog, mergeCatalogs, withoutShadowedLegacyAlbum } from "./catalog-source.js";
import { LEGACY_ALBUM_ID, LEGACY_CHAIN_ID, LEGACY_CONTRACT, LEGACY_EDITION_ID, LEGACY_IPFS_GATEWAY, LEGACY_IPFS_MEDIA, LEGACY_URI_TEMPLATE, LEGACY_METADATA_BASE, isLegacyMainnetEdition, isPublicLegacyArtwork, legacyAudioTokenId, legacyExperienceId, legacyIpfsToHttp, legacyMetadataUri } from "./legacy-genesis.js";
import { DEFAULT_COLLECTION_CONFIG, FALLBACK_METADATA, ipfsToHttp } from "./web3.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { marketplaceCatalog, primaryCollectForEdition } from "./marketplace-surface.js";

// Rows shaped like the public API output for the 019 seed.
const apiRows = {
  artists: [{ id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE", verified: true, application_metadata: { profileArtwork: "/assets/voidcaller_art_4.png" } }],
  releases: [{ id: LEGACY_ALBUM_ID, artist_id: "voidcaller", slug: LEGACY_ALBUM_ID, title: "VOIDCALLER", status: "PUBLISHED", release_metadata: { subtitle: "Self-titled EP", artwork: "/assets/voidcaller_art_4.png" } }],
  editions: [{
    id: LEGACY_EDITION_ID,
    release_id: LEGACY_ALBUM_ID,
    title: "Chapter I · The Relic",
    supply: "1620",
    status: "PUBLISHED",
    chain_id: String(LEGACY_CHAIN_ID),
    contract_address: LEGACY_CONTRACT,
    application_metadata: {
      legacy: true,
      primarySale: false,
      tokenIds: ["0", "1", "2", "3"],
      marketplaces: [{ name: "OPENSEA", href: "https://opensea.io/collection/voidcaller-avalanche" }, { name: "JOEPEGS", href: "https://joepegs.com/collections/avalanche/voidcaller" }],
    },
  }],
  experiences: [0, 1, 2, 3].map((tokenId) => ({ id: legacyExperienceId(tokenId), edition_id: LEGACY_EDITION_ID, release_id: LEGACY_ALBUM_ID, title: `Track ${tokenId}`, experience_type: "AUDIO", status: "PUBLISHED", gated: true, protected: true })),
};

describe("legacy mainnet catalog rows", () => {
  it("maps the seeded legacy edition as minted with OpenSea/Joepegs links, never as a Collect path", () => {
    const catalog = mapPublishedCatalog(apiRows);
    const edition = catalog.editions.find((item) => item.id === LEGACY_EDITION_ID);
    expect(edition).toMatchObject({ chainId: LEGACY_CHAIN_ID, contractAddress: LEGACY_CONTRACT, chain: "AVALANCHE", status: "minted", legacy: true, tokenIds: ["0", "1", "2", "3"] });
    expect(edition.marketplaces.map((item) => item.name)).toEqual(["OPENSEA", "JOEPEGS"]);
    expect(isLegacyMainnetEdition(edition)).toBe(true);
    const primary = primaryCollectForEdition(edition);
    expect(primary.availability).toBe("minted");
    expect(primary.certified).toBe(false);
    expect(primary.label).not.toBe("Collect");
    for (const record of marketplaceCatalog([catalog])) {
      for (const item of record.editions) expect(item.primary.availability).not.toBe("available");
    }
  });

  it("never offers primary collect for the legacy contract even if a row claims to be available", () => {
    const primary = primaryCollectForEdition({ id: "x", contractAddress: LEGACY_CONTRACT.toUpperCase().replace("0X", "0x"), chainId: LEGACY_CHAIN_ID, status: "available" });
    expect(primary.availability).toBe("minted");
    expect(primary.label).toBe("Open experience");
  });

  it("keeps Fuji editions collectable exactly as before", () => {
    const catalog = mapPublishedCatalog({ editions: [{ id: "fuji-ed", release_id: "r", title: "Fuji", status: "PUBLISHED", chain_id: FUJI_RELEASE_CONFIG.chainId, contract_address: FUJI_RELEASE_CONFIG.contractAddress, application_metadata: { fuji: { tokenId: "9" }, tokenIds: ["1", "2"] } }] });
    expect(catalog.editions[0]).toMatchObject({ status: "available", tokenIds: ["9"] });
    expect(catalog.editions[0].legacy).toBeUndefined();
  });

  it("drops the published legacy album from the storefront when data.js already renders it, keeping its experiences", () => {
    const published = mapPublishedCatalog(apiRows);
    const trimmed = withoutShadowedLegacyAlbum(published);
    expect(trimmed.releases.some((item) => item.id === LEGACY_ALBUM_ID)).toBe(false);
    expect(trimmed.editions.some((item) => item.id === LEGACY_EDITION_ID)).toBe(false);
    expect(trimmed.experiences.map((item) => item.id)).toEqual([0, 1, 2, 3].map(legacyExperienceId));
    const merged = mergeCatalogs([VOIDCALLER_CATALOG, trimmed]);
    expect(merged.releases.filter((item) => item.artistId === "voidcaller").map((item) => item.id)).toEqual(["voidcaller-self-titled"]);
    expect(merged.editions.filter((item) => isLegacyMainnetEdition(item)).map((item) => item.id)).toEqual(["voidcaller-chapter-i"]);
  });

  it("keeps the published legacy album when no static catalog renders it", () => {
    const published = mapPublishedCatalog(apiRows);
    const empty = createCatalog({ artists: [], releases: [], editions: [], tokens: [], collections: [], experiences: [] });
    expect(withoutShadowedLegacyAlbum(published, [empty])).toBe(published);
  });
});

describe("legacy public IPFS media", () => {
  it("matches the on-chain metadata the frontend already knows and resolves through the same gateway", () => {
    expect(LEGACY_URI_TEMPLATE).toBe(`${LEGACY_METADATA_BASE}/{id}`);
    expect(legacyMetadataUri(2)).toBe(`${LEGACY_METADATA_BASE}/2`);
    expect(LEGACY_IPFS_GATEWAY).toBe(DEFAULT_COLLECTION_CONFIG.metadata.gateway);
    for (const item of FALLBACK_METADATA) {
      const media = LEGACY_IPFS_MEDIA[item.tokenId];
      expect(media.image).toBe(item.image);
      expect(media.animationUrl).toBe(item.animation_url);
      expect(legacyIpfsToHttp(media.image)).toBe(ipfsToHttp(media.image));
      expect(legacyIpfsToHttp(media.animationUrl)).toBe(ipfsToHttp(media.animationUrl));
      expect(legacyAudioTokenId(item.animation_url)).toBe(item.tokenId);
      expect(isPublicLegacyArtwork(item.image)).toBe(true);
      expect(isPublicLegacyArtwork(ipfsToHttp(item.image))).toBe(true);
      expect(isPublicLegacyArtwork(item.animation_url)).toBe(false);
    }
    expect(legacyAudioTokenId("ipfs://bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234/1.mp3")).toBeNull();
    expect(isPublicLegacyArtwork("ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/9.gif")).toBe(false);
  });

  it("requests full audio for each EP track from that token's legacy experience", () => {
    for (const track of VC_DATA.firstEPTracks) expect(track.protectedMedia).toEqual({ experienceId: legacyExperienceId(track.tokenId), mediaType: "AUDIO" });
  });

  it("renders published IPFS artwork through the gateway whether stored as ipfs:// or gateway URL", () => {
    const image = LEGACY_IPFS_MEDIA[1].image;
    for (const artwork of [image, ipfsToHttp(image)]) {
      const catalog = mapPublishedCatalog({ ...apiRows, releases: [{ ...apiRows.releases[0], release_metadata: { artwork } }], editions: [{ ...apiRows.editions[0], application_metadata: { ...apiRows.editions[0].application_metadata, artwork } }] });
      expect(catalog.releases[0].artwork).toBe(ipfsToHttp(image));
      expect(catalog.editions[0].artwork).toBe(ipfsToHttp(image));
    }
  });
});
