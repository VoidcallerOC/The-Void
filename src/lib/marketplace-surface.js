import { FUJI_RELEASE_CONFIG, isCertifiedFujiEdition } from "./fuji-release.js";
import { MARKETPLACE_CONFIG } from "./marketplace.js";
import { CHAINS, isValidAddress } from "./web3.js";
import { VOIDCALLER_CATALOG } from "../data.js";
import { isLegacyMainnetEdition } from "./legacy-genesis.js";
import { SALE_AVAILABILITY, isOpenEditionSupply, isSaleAvailabilityState, primarySaleAvailability, saleAvailabilityLabel } from "./primary-sale-availability.js";

export const MARKETPLACE_STATE = Object.freeze({
  LIVE: "LIVE",
  IMPLEMENTED_NOT_LIVE: "IMPLEMENTED / NOT LIVE",
  UNAVAILABLE: "UNAVAILABLE",
});

export const MARKETPLACE_STATUS_LABEL = Object.freeze({
  [MARKETPLACE_STATE.LIVE]: "LIVE",
  [MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE]: "NOT YET LIVE",
  [MARKETPLACE_STATE.UNAVAILABLE]: "UNAVAILABLE",
});

const WEI_PER_AVAX = 10n ** 18n;

export function marketplaceStatusLabel(status) {
  return MARKETPLACE_STATUS_LABEL[status] || MARKETPLACE_STATUS_LABEL[MARKETPLACE_STATE.UNAVAILABLE];
}

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

export function marketplaceSecondaryAvailability(status) {
  if (status === MARKETPLACE_STATE.LIVE) return "Live index";
  if (status === MARKETPLACE_STATE.UNAVAILABLE) return "Index unavailable";
  return "Not yet live";
}

export function marketplaceCopy(status = resolveInfrastructureStatus()) {
  if (status === MARKETPLACE_STATE.LIVE) {
    return {
      eyebrow: "The Void · music marketplace",
      title: "Marketplace",
      body: "Collect editions from The Void. See the artist, the release, what the collector receives, and the experience it unlocks — then collect. Secondary listings appear only when the indexer confirms a real marketplace event.",
    };
  }
  if (status === MARKETPLACE_STATE.UNAVAILABLE) {
    return {
      eyebrow: "The Void · music marketplace",
      title: "Marketplace",
      body: "Collect editions from The Void. Primary collection is unchanged. The secondary index is unreachable, so no listings are shown or invented.",
    };
  }
  return {
    eyebrow: "The Void · music marketplace",
    title: "Marketplace",
    body: "Collect editions from The Void. See the artist, the release, what the collector receives, and the experience it unlocks — then collect. Secondary trading is not yet live.",
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
  // Accept "0.5", ".5" and "5." alike; AVAX has 18 decimals, so never more.
  if (!raw || !/^(\d+(\.\d{0,18})?|\.\d{1,18})$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  const fracWei = (frac + "0".repeat(18)).slice(0, 18);
  return (BigInt(whole || "0") * WEI_PER_AVAX + BigInt(fracWei)).toString();
}

export function editionPriceLabel(edition) {
  return formatWeiAsAvax(edition?.priceWei || edition?.price || null);
}

export function listingIsDisplayable(listing) {
  return listing?.authority === "INDEXED"
    && String(listing.status || "").toUpperCase() === "ACTIVE"
    && Number(listing.amount) > 0
    && Boolean(listing.seller)
    && Boolean(formatWeiAsAvax(listing.price));
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

export function editionTypeLabel(edition) {
  if (edition?.releaseType) return edition.releaseType;
  return "Collectible release";
}

/**
 * A release-per-contract (factory) edition: its own release contract and its own
 * primary sale. Never the certified shared Fuji contract.
 */
export function isReleaseScopedEdition(edition) {
  const tokenId = edition?.tokenIds?.[0];
  return Boolean(edition)
    && !isCertifiedFujiEdition(edition)
    && isValidAddress(String(edition.contractAddress || ""))
    && isValidAddress(String(edition.primarySaleAddress || ""))
    && /^\d+$/.test(String(tokenId ?? ""));
}

/** Sale availability for a release-scoped edition: live sale tuple first, then the API's state. */
export function editionSaleAvailability(edition, now = Date.now()) {
  if (edition?.primarySale) return primarySaleAvailability(edition.primarySale, { editionSupply: edition.supply, now });
  if (isSaleAvailabilityState(edition?.saleAvailability)) return { state: edition.saleAvailability, openEdition: false, startTime: 0, endTime: 0 };
  return null;
}

function releaseScopedCollect(edition, now) {
  const sale = editionSaleAvailability(edition, now);
  const open = sale?.state === SALE_AVAILABILITY.OPEN;
  return {
    availability: open ? "available" : "unavailable",
    status: MARKETPLACE_STATE.LIVE,
    label: open ? "Collect" : "View edition",
    href: `/edition/${edition.id}`,
    saleState: sale?.state || null,
    saleLabel: sale ? saleAvailabilityLabel(sale) : "",
    note: open
      ? "Primary collect from this release's own sale contract."
      : sale
        ? `${saleAvailabilityLabel(sale)}.`
        : "Sale status is read from this release's own sale contract.",
    certified: false,
    releaseScoped: true,
  };
}

export function primaryCollectForEdition(edition, { now = Date.now() } = {}) {
  if (!edition) {
    return { availability: "unavailable", status: MARKETPLACE_STATE.UNAVAILABLE, label: "Unavailable", href: "/marketplace", note: "This collect path is not available.", certified: false };
  }
  if (isCertifiedFujiEdition(edition)) {
    const minted = String(edition.status).toLowerCase() === "minted";
    const hasTokenId = Array.isArray(edition.tokenIds) && edition.tokenIds.length > 0;
    return {
      availability: minted ? "minted" : hasTokenId ? "available" : "unavailable",
      status: MARKETPLACE_STATE.LIVE,
      label: minted ? "Owned" : hasTokenId ? "Collect" : "View edition",
      href: `/edition/${edition.id}`,
      note: minted
        ? "You already hold this certified Fuji edition. Open the collector experience."
        : !hasTokenId
          ? "This published edition is missing its on-chain Fuji token ID and cannot be collected yet."
        : "Primary collect on certified Fuji. Secondary trading is a separate, not-yet-live layer.",
      certified: true,
    };
  }
  // Legacy mainnet editions are minted out and remain catalog-only. They never
  // get a Collect button, whatever status the catalog row carries.
  if (String(edition.status).toLowerCase() === "minted" || isLegacyMainnetEdition(edition)) {
    return {
      availability: "minted",
      status: MARKETPLACE_STATE.LIVE,
      label: "View edition",
      href: `/edition/${edition.id}`,
      note: "Primary mint for this edition is complete. View the edition or use its linked experience. Secondary collection is not yet live.",
      certified: false,
    };
  }
  if (isReleaseScopedEdition(edition)) return releaseScopedCollect(edition, now);
  if (String(edition.status).toLowerCase() === "available") {
    return {
      availability: "unavailable",
      status: MARKETPLACE_STATE.LIVE,
      label: "View edition",
      href: `/edition/${edition.id}`,
      note: "Primary collection is available only for editions published on the certified Fuji contract.",
      certified: false,
    };
  }
  return {
    availability: "unavailable",
    status: MARKETPLACE_STATE.UNAVAILABLE,
    label: "Unavailable",
    href: `/edition/${edition.id}`,
    note: "This edition is not currently collectible on the primary path.",
    certified: false,
  };
}

// Shared-contract (certified V1) editions cannot be created with supply 0, so a
// catalog supply of 0 there still means nothing is left to press.
function sharedContractPressingsRemain(edition) {
  if (edition?.supply === undefined || edition?.supply === null || edition?.supply === "") return true;
  const supply = Number(edition.supply);
  return !Number.isFinite(supply) || supply > 0;
}

/**
 * Whether the card or page may offer this edition as collectable. A
 * release-scoped edition follows its sale; supply 0 there is an open edition.
 */
export function editionIsCollectable(edition, primary = primaryCollectForEdition(edition)) {
  if (primary?.availability !== "available") return false;
  return primary.releaseScoped ? true : sharedContractPressingsRemain(edition);
}

/** Supply / availability line for an edition card or page. */
export function editionSupplyLabel(edition, primary = primaryCollectForEdition(edition)) {
  if (primary?.releaseScoped) {
    if (primary.saleLabel) return primary.saleLabel;
    return isOpenEditionSupply(edition?.supply) ? "Open edition" : `Supply ${edition.supply}`;
  }
  if (!sharedContractPressingsRemain(edition)) return "No pressings remain";
  return edition?.supply ? `Supply ${edition.supply}` : "Open supply";
}

/** Factory (release-per-contract) editions lead; shared-contract editions follow. */
export function releaseScopedFirst(items = []) {
  return [...items].sort((a, b) => Number(Boolean(b.primary?.releaseScoped)) - Number(Boolean(a.primary?.releaseScoped)));
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

export function marketplaceCatalog(catalogs = [VOIDCALLER_CATALOG]) {
  return catalogs.flatMap((catalog) => (catalog.releases || []).map((release) => {
    const artist = (catalog.artists || []).find((item) => item.id === release.artistId) || null;
    const editions = (catalog.editions || []).filter((edition) => edition.releaseId === release.id);
    const experiences = (catalog.experiences || []).filter((experience) => (release.experiences || []).includes(experience.id));
    return {
      catalog,
      artist,
      release,
      editions: editions.map((edition) => ({
        edition,
        artist,
        release,
        experiences: (catalog.experiences || []).filter((experience) => (edition.experienceIds || []).includes(experience.id) || experience.editionId === edition.id),
        primary: primaryCollectForEdition(edition),
        chain: resolveEditionChain(edition),
      })),
      experiences,
    };
  }));
}

export function flattenMarketplaceEditions(catalogs = [VOIDCALLER_CATALOG]) {
  return marketplaceCatalog(catalogs).flatMap((record) => record.editions);
}

export function findMarketplaceEdition(editionId, catalogs = [VOIDCALLER_CATALOG]) {
  for (const record of marketplaceCatalog(catalogs)) {
    const match = record.editions.find((item) => item.edition.id === editionId);
    if (match) return match;
  }
  return null;
}

export function featuredMarketplaceRecord(records = []) {
  return records.find((record) => record.editions.some((item) => item.primary.availability === "available" && item.primary.certified))
    || records.find((record) => record.editions.some((item) => item.primary.availability === "available"))
    || records[0]
    || null;
}

export function collectableFirst(items = []) {
  return [...items].sort((a, b) => Number((b.primary || b.editions?.[0]?.primary)?.availability === "available") - Number((a.primary || a.editions?.[0]?.primary)?.availability === "available"));
}

export function certifiedFujiReleaseUnchanged() {
  return FUJI_RELEASE_CONFIG.chainId === 43113
    && FUJI_RELEASE_CONFIG.contractName === "VoidRelease1155"
    && FUJI_RELEASE_CONFIG.contractAddress.toLowerCase() === "0x262b774cf9a1949170b58e2d57f6189980fe757b";
}

export function secondaryTradingIsLive(config = MARKETPLACE_CONFIG) {
  return resolveInfrastructureStatus(config) === MARKETPLACE_STATE.LIVE;
}
