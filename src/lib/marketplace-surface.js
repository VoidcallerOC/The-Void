import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { MARKETPLACE_CONFIG } from "./marketplace.js";
import { CHAINS, isValidAddress } from "./web3.js";
import { VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG } from "../data.js";

export const MARKETPLACE_STATE = Object.freeze({
  LIVE: "LIVE",
  IMPLEMENTED_NOT_LIVE: "IMPLEMENTED / NOT LIVE",
  UNAVAILABLE: "UNAVAILABLE",
});

const WEI_PER_AVAX = 10n ** 18n;

export function resolveInfrastructureStatus(config = MARKETPLACE_CONFIG) {
  const address = String(config?.address || "").trim();
  const chainId = Number(config?.chainId || 0);
  if (config?.enabled && isValidAddress(address) && Number.isInteger(chainId) && chainId > 0) {
    return MARKETPLACE_STATE.LIVE;
  }
  return MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE;
}

export function resolveSecondaryStatus({ infrastructure = resolveInfrastructureStatus(), listingsState = "idle" } = {}) {
  if (infrastructure !== MARKETPLACE_STATE.LIVE) return MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE;
  if (listingsState === "error") return MARKETPLACE_STATE.UNAVAILABLE;
  return MARKETPLACE_STATE.LIVE;
}

export function marketplaceCopy(status = resolveInfrastructureStatus()) {
  if (status === MARKETPLACE_STATE.LIVE) {
    return {
      eyebrow: "Secondary collection · live index",
      title: "Marketplace",
      body: "Secondary collection around Releases and Editions. Listings appear only after the indexer confirms a marketplace event. A wallet receipt is not a completed trade.",
    };
  }
  if (status === MARKETPLACE_STATE.UNAVAILABLE) {
    return {
      eyebrow: "Secondary collection · unavailable",
      title: "Marketplace",
      body: "The secondary-collection index is not reachable. Primary collection paths are unchanged. No listings are invented while the index is down.",
    };
  }
  return {
    eyebrow: "Secondary collection · implemented / not live",
    title: "Marketplace",
    body: "The Void Marketplace is the secondary-collection layer around Releases and Editions. Listing, purchase, and receipt verification are implemented, but no reviewed marketplace contract is configured. This is not live trading.",
  };
}

export function formatWeiAsAvax(wei) {
  if (wei === null || wei === undefined || !/^[0-9]+$/.test(String(wei))) return null;
  const value = BigInt(wei);
  const whole = value / WEI_PER_AVAX;
  const frac = (value % WEI_PER_AVAX).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} AVAX` : `${whole} AVAX`;
}

export function parseAvaxToWei(avax) {
  const raw = String(avax || "").trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  const fracWei = (frac + "0".repeat(18)).slice(0, 18);
  return (BigInt(whole || "0") * WEI_PER_AVAX + BigInt(fracWei)).toString();
}

export function resolveEditionChain(edition) {
  const chainId = Number(edition?.chainId);
  const fromKnown = Object.values(CHAINS).find((item) => item.id === chainId);
  if (fromKnown) return fromKnown;
  if (chainId === FUJI_RELEASE_CONFIG.chainId) {
    return {
      key: "fuji",
      id: FUJI_RELEASE_CONFIG.chainId,
      hexId: FUJI_RELEASE_CONFIG.chainHexId,
      name: FUJI_RELEASE_CONFIG.networkName,
      short: "FUJI",
      rpc: FUJI_RELEASE_CONFIG.rpcUrl,
      explorer: FUJI_RELEASE_CONFIG.explorer,
      token: "AVAX",
    };
  }
  return null;
}

export function primaryCollectForEdition(edition) {
  if (!edition) {
    return { availability: "unavailable", status: MARKETPLACE_STATE.UNAVAILABLE, label: "No edition", href: "/discover", note: "This collect path is not available." };
  }
  if (edition.id === "summit-demo-edition") {
    return {
      availability: "available",
      status: MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE,
      label: "Primary collect on certified Fuji",
      href: "/fuji-integration",
      note: "Issuer-controlled mint on VoidRelease1155. Certified Fuji path — not secondary trading, and not a live-certified mint until a collector receipt exists.",
    };
  }
  if (String(edition.status).toLowerCase() === "minted") {
    return {
      availability: "minted",
      status: MARKETPLACE_STATE.LIVE,
      label: "Primary mint complete",
      href: "/reliquary",
      note: "This edition was collected on the primary path. Open the collector experience. Secondary collection is a separate, not-live layer.",
    };
  }
  if (String(edition.status).toLowerCase() === "available") {
    return {
      availability: "available",
      status: MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE,
      label: "Primary collection available",
      href: `/edition/${edition.id}`,
      note: "Primary collection is the music-native Collect path. It is not a secondary marketplace trade.",
    };
  }
  return {
    availability: "unavailable",
    status: MARKETPLACE_STATE.UNAVAILABLE,
    label: "Primary collection unavailable",
    href: `/edition/${edition.id}`,
    note: "This edition is not currently collectible on the primary path.",
  };
}

export function listingMatchesEdition(listing, edition) {
  if (!listing || !edition) return false;
  const listingContract = String(listing.tokenContract || listing.contract || "").toLowerCase();
  const editionContract = String(edition.contractAddress || "").toLowerCase();
  if (!listingContract || !editionContract || listingContract !== editionContract) return false;
  if (Number(listing.chain || listing.chainId) !== Number(edition.chainId)) return false;
  return (edition.tokenIds || []).map(String).includes(String(listing.tokenId));
}

export function attachIndexedListings({ catalogs, listings }) {
  if (!Array.isArray(listings)) throw new Error("Indexed listings must be an array from the marketplace index.");
  const editions = catalogs.flatMap((catalog) => catalog.editions || []);
  return listings.map((listing) => {
    const edition = editions.find((item) => listingMatchesEdition(listing, item)) || null;
    return { listing, edition };
  });
}

export function listingsForEdition(listings = [], edition) {
  if (!Array.isArray(listings) || !edition) return [];
  return listings.filter((listing) => listingMatchesEdition(listing, edition));
}

export function marketplaceCatalog(catalogs = [VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG]) {
  return catalogs.flatMap((catalog) => (catalog.releases || []).map((release) => {
    const artist = catalog.artists.find((item) => item.id === release.artistId) || null;
    const editions = catalog.editions.filter((edition) => edition.releaseId === release.id);
    const experiences = catalog.experiences.filter((experience) => (release.experiences || []).includes(experience.id));
    return {
      catalog,
      artist,
      release,
      editions: editions.map((edition) => ({
        edition,
        artist,
        release,
        experiences: catalog.experiences.filter((experience) => (edition.experienceIds || []).includes(experience.id)),
        primary: primaryCollectForEdition(edition),
        chain: resolveEditionChain(edition),
      })),
      experiences,
    };
  }));
}

export function findMarketplaceEdition(editionId, catalogs = [VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG]) {
  for (const record of marketplaceCatalog(catalogs)) {
    const match = record.editions.find((item) => item.edition.id === editionId);
    if (match) return match;
  }
  return null;
}

export function certifiedFujiReleaseUnchanged() {
  return FUJI_RELEASE_CONFIG.chainId === 43113
    && FUJI_RELEASE_CONFIG.contractName === "VoidRelease1155"
    && FUJI_RELEASE_CONFIG.contractAddress.toLowerCase() === "0x262b774cf9a1949170b58e2d57f6189980fe757b";
}

export function secondaryTradingIsLive(config = MARKETPLACE_CONFIG) {
  return resolveInfrastructureStatus(config) === MARKETPLACE_STATE.LIVE;
}
