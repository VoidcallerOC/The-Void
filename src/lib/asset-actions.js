import { isReleasePerContractCandidate } from "./secondary-listing.js";

// Asset-first actions. One place decides which marketplace actions an asset offers and how its exact identity
// (edition, chain, contract, token id) travels to the one ListingPanel that executes them. Showing an action here is a
// convenience, never an authorization: ListingPanel re-reads ownership, approval, marketplace and royalty on chain
// before any transaction, and an owner-only action is offered only where the surface already believes it is owned.

const DECIMAL = /^\d+$/;

/** The exact token of `edition` being acted on, or null when `tokenId` is absent or not one of the edition's ids. */
export function assetTokenId(edition, tokenId) {
  if (tokenId === undefined || tokenId === null || !DECIMAL.test(String(tokenId))) return null;
  const ids = (edition?.tokenIds || []).map((id) => String(id));
  return ids.includes(String(tokenId)) ? String(tokenId) : null;
}

/** Whether this asset can be listed on its marketplace at all (factory releases and the Genesis ids 0-3). With a token id,
 * that exact token must be one of the edition's ids. */
export function canListAsset(edition, tokenId = null) {
  if (!isReleasePerContractCandidate(edition)) return false;
  return tokenId === null || tokenId === undefined || assetTokenId(edition, tokenId) !== null;
}

/** The listing entry point for this asset: its edition page, scrolled to the listing panel, carrying the exact token. */
export function listingHref(edition, tokenId = null) {
  const token = assetTokenId(edition, tokenId);
  return `/edition/${encodeURIComponent(edition.id)}${token !== null ? `?token=${token}` : ""}#secondary-listing`;
}

/** The token a listing link asked for (`?token=`), as a preference only: the panel uses it only if the wallet holds it. */
export function requestedTokenId(search) {
  const value = new URLSearchParams(search || "").get("token");
  return value !== null && DECIMAL.test(value) ? value : null;
}
