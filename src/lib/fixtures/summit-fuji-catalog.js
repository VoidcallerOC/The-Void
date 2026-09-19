/**
 * TEST / DEVELOPMENT FIXTURE ONLY.
 *
 * Summit was used to certify the Fuji VoidRelease1155 path.
 * It is not a public release, catalog entry, collectible, or product.
 * Production catalog code must not import this module except behind
 * isSummitDemoEnabled() (default OFF).
 */
import { createArtist, createCatalog, createCollection, createEdition, createExperience, createRelease, createToken, EXPERIENCE_TYPES } from "../../domain/models.js";
import { FUJI_RELEASE_CONFIG, fujiTokenId } from "../fuji-release.js";
import { SUMMIT_DEMO_IDS } from "../summit-demo.js";

export const FUJI_INTEGRATION_CATALOG = (() => {
  const artist = createArtist({
    id: SUMMIT_DEMO_IDS.artist,
    name: "THE VOID",
    handle: "the-void",
    bio: "Internal Fuji certification fixture. Not a public artist release.",
    verified: true,
  });
  const releaseId = SUMMIT_DEMO_IDS.release;
  const editionId = SUMMIT_DEMO_IDS.edition;
  const tokenId = fujiTokenId(releaseId, editionId).toString();
  const release = createRelease({
    id: releaseId,
    artistId: artist.id,
    title: "THE VOID — SUMMIT DEMO",
    productType: "EP",
    subtitle: "Internal Fuji certification fixture",
    description: "Not a public release. Used only to exercise the certified Fuji collect path in tests and opt-in staging.",
    story: "Certification fixture for one record → one edition → one collect → one owner → one gated session.",
    status: "published",
    artwork: "/assets/voidcaller_art_4.png",
    experiences: [SUMMIT_DEMO_IDS.experience],
    tracks: [{ n: 1, title: "Summit Session", time: "03:17" }],
  });
  const edition = createEdition({
    id: editionId,
    releaseId,
    title: "SUMMIT EDITION",
    description: "Internal certification edition. Not a public collectible.",
    includes: ["Summit Session", "Ownership-gated protected media", "On-chain collector proof"],
    tokenIds: [tokenId],
    contractId: "voidrelease1155-fuji-certified",
    contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
    chainId: FUJI_RELEASE_CONFIG.chainId,
    chain: FUJI_RELEASE_CONFIG.network,
    supply: "10",
    status: "available",
    metadataUri: "ipfs://the-void-summit-demo",
    experienceIds: [SUMMIT_DEMO_IDS.experience],
    tier: "staging",
  });
  const experience = createExperience({
    id: SUMMIT_DEMO_IDS.experience,
    experienceType: EXPERIENCE_TYPES.AUDIO,
    title: "THE VOID — SUMMIT SESSION",
    description: "Protected session used by the Fuji certification fixture.",
    requirements: [{
      type: "ownership",
      contract: FUJI_RELEASE_CONFIG.contractAddress,
      tokenIds: [tokenId],
      minAmount: 1,
      chainId: FUJI_RELEASE_CONFIG.chainId,
    }],
    media: { type: "audio", releaseId, protected: true, previewAvailable: true },
  });
  return createCatalog({
    artists: [artist],
    releases: [release],
    editions: [edition],
    tokens: [createToken({ id: `summit-token-${tokenId}`, editionId, tokenId, name: "Summit Edition" })],
    collections: [createCollection({
      id: SUMMIT_DEMO_IDS.collection,
      name: "The Void · Summit",
      artistIds: [artist.id],
      releaseIds: [release.id],
      editionIds: [edition.id],
      description: "Internal Fuji Summit certification fixture. Not a public collection.",
    })],
    experiences: [experience],
  });
})();
