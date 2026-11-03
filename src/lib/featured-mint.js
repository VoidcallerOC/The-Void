import { useEffect, useMemo, useState } from "react";
import { useMarketplaceCatalogs } from "./catalog-source.js";
import { collapsePublicCatalog } from "./summit-demo.js";
import { collectableEditionGroups, editionPriceLabel } from "./marketplace-surface.js";
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
  const preview = playableTrackFor(tokenView(catalog, { edition, release }).token, { artwork: artworkFor(edition, release) });
  return {
    edition,
    release,
    artist,
    title: release?.title || edition.title,
    href: `/edition/${edition.id}`,
    price: editionPriceLabel(edition),
    saleLabel: primary?.saleLabel || "",
    preview: preview ? { ...preview, title: preview.title || release?.title || edition.title } : null,
  };
}

export function useFeaturedMint() {
  const catalog = useMarketplaceCatalogs();
  return useMemo(() => featuredMintItem(catalog), [catalog]);
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
