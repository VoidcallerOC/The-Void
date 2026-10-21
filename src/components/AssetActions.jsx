import { Link } from "react-router-dom";
import { canListAsset, listingHref, assetTokenId } from "../lib/asset-actions.js";

/**
 * "List for sale" for one asset, from wherever the asset is shown. Renders nothing unless the surface reports the asset
 * as owned and the asset is listable. It only navigates: the edition's ListingPanel verifies ownership of the exact
 * token on chain and runs the one listing flow.
 */
export function ListForSaleLink({ edition, tokenId = null, owned, style, label = "List for sale" }) {
  if (!owned || !edition?.id || !canListAsset(edition, tokenId)) return null;
  const token = assetTokenId(edition, tokenId);
  const name = edition.title || "this edition";
  return (
    <Link to={listingHref(edition, token)} style={style} aria-label={token !== null ? `${label}: ${name}, token #${token}` : `${label}: ${name}`}>
      {label}
    </Link>
  );
}
