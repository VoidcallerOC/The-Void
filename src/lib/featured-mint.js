import { useEffect, useMemo, useState } from "react";
import { useMarketplaceCatalogs } from "./catalog-source.js";
import { collapsePublicCatalog } from "./summit-demo.js";
import { collectableEditionGroups, editionPriceLabel, editionSaleAvailability } from "./marketplace-surface.js";
import { artworkSources } from "./artwork.js";
import { playableTrackFor, tokenView } from "./token-view.js";
import { artworkFor } from "./marketplace-chrome.js";
import { releaseBindingFor } from "./claim-state.js";
import { GENESIS_CLAIM_PHASES, fetchGenesisClaimConfig, genesisClaimPhase } from "./genesis-claim.js";

/**
 * The edition whose primary mint is open right now, read from the same catalog and sale state Discover uses
 * (release-scoped editions follow their own sale contract's window). Null when nothing is mintable, so every
 * "Mint" surface disappears on its own once the sale closes. Factory releases lead (releaseScopedFirst).
 */
export function featuredMintItem(catalog) {
  const item = collectableEditionGroups(collapsePublicCatalog(catalog)).flatMap((group) => group.items)[0];
  if (!item) return null;
  const { edition, release, artist, primary } = item;
  // Sized gateway URLs first, then the plain gateway and the public one, so a slow image falls back (the bare
  // edition artwork URL rendered as a broken image in the player on production).
  const artwork = artworkSources(artworkFor(edition, release), { width: 1200 });
  const thumb = artworkSources(artworkFor(edition, release), { width: 240 })[0] || artwork[0] || "";
  const preview = playableTrackFor(tokenView(catalog, { edition, release }).token, { artwork: thumb });
  const endTime = Number(editionSaleAvailability(edition)?.endTime) || 0;
  return {
    edition,
    release,
    artist,
    title: release?.title || edition.title,
    href: `/edition/${edition.id}`,
    price: editionPriceLabel(edition),
    saleLabel: primary?.saleLabel || "",
    artwork,
    endTime,
    preview: preview ? { ...preview, title: preview.title || release?.title || edition.title } : null,
  };
}

export function useFeaturedMint() {
  const catalog = useMarketplaceCatalogs();
  return useMemo(() => featuredMintItem(catalog), [catalog]);
}

/** Time left in the sale, coarse and human: "6 days left", "5 hours left", "Last hour". Empty without an end. */
export function timeLeftLabel(endTime, nowMs = Date.now()) {
  const seconds = Number(endTime) - Math.floor(nowMs / 1000);
  if (!Number.isFinite(seconds) || Number(endTime) <= 0 || seconds <= 0) return "";
  const days = Math.floor(seconds / 86400);
  if (days >= 2) return `${days} days left`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 2) return `${hours} hours left`;
  return hours === 1 ? "1 hour left" : "Last hour";
}

/** Button text for a mint call to action: "Mint Forgive & Forget · 0.25 AVAX". */
export function mintLabel(featured) {
  return `Mint ${featured.title}${featured.price ? ` · ${featured.price}` : ""}`;
}

/**
 * Whether this edition's Genesis claim is open right now (server-verified target, claim window running).
 * The edition page offers "Open claim page" only then; a closed or unrelated claim would be a dead end.
 */
export function useClaimOpenFor(edition) {
  const binding = edition ? releaseBindingFor(edition) : null;
  const key = binding?.valid ? `${binding.releaseContractAddress.toLowerCase()}:${binding.tokenId}` : "";
  // The answer is kept with the key it was read for, so a different edition never shows a stale "open".
  const [state, setState] = useState({ key: "", open: false });
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    fetchGenesisClaimConfig()
      .then((target) => {
        if (!live) return;
        const matches = `${String(target.releaseContract).toLowerCase()}:${String(target.tokenId)}` === key;
        setState({ key, open: matches && genesisClaimPhase(target, Math.floor(Date.now() / 1000)) === GENESIS_CLAIM_PHASES.GENESIS });
      })
      .catch(() => { if (live) setState({ key, open: false }); });
    return () => { live = false; };
  }, [key]);
  return Boolean(key) && state.key === key && state.open;
}
