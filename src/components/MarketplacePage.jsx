import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { EmptyRail, QuietStatus, SecondaryListingCard, SectionHead } from "./MarketplaceCards.jsx";
import { fetchIndexedListings, fetchMarketplacePresentation, fetchMarketplaceVolume } from "../lib/marketplace-api.js";
import { marketplaceHeroImage } from "../lib/marketplace-presentation.js";
import { MarketplaceHeroEditor } from "./MarketplaceHeroEditor.jsx";
import { MARKETPLACE_CONFIG } from "../lib/marketplace.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { useWallet } from "../lib/wallet-context.js";
import { contentShell } from "../lib/marketplace-chrome.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";
import {
  MARKETPLACE_STATE,
  editionOwnedByWallet,
  flattenMarketplaceEditions,
  hasPublicLifecycle,
  formatWeiAsAvax,
  listingIsDisplayable,
  listingsForEdition,
  marketplaceSecondaryAvailability,
  resolveInfrastructureStatus,
  resolveSecondaryStatus,
} from "../lib/marketplace-surface.js";

const EMPTY_LISTINGS = [];
const INDEX_NOTE = {
  [MARKETPLACE_STATE.LIVE]: "Buy from and sell to other holders. A listing appears only when the indexer confirms a real marketplace event.",
  [MARKETPLACE_STATE.UNAVAILABLE]: "The listing index is unreachable, so no listings are shown or invented.",
  [MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE]: "Secondary trading is not yet live.",
};

export function MarketplacePage() {
  const [params] = useSearchParams();
  const focusRelease = params.get("release") || "";
  const focusEdition = params.get("edition") || "";
  const rawCatalog = useMarketplaceCatalogs();
  const catalog = useMemo(() => collapsePublicCatalog(rawCatalog), [rawCatalog]);
  const wallet = useWallet();
  const infrastructure = resolveInfrastructureStatus();
  const editions = useMemo(() => flattenMarketplaceEditions([catalog])
    .filter(hasPublicLifecycle)
    .filter((item) => !focusRelease || item.release.id === focusRelease)
    .filter((item) => !focusEdition || item.edition.id === focusEdition), [catalog, focusEdition, focusRelease]);
  const [listingRequest, setListingRequest] = useState(null);
  const [volume, setVolume] = useState(null);
  const [presentation, setPresentation] = useState(null);
  const requestKey = `${infrastructure}:${MARKETPLACE_CONFIG.chainId}:${String(MARKETPLACE_CONFIG.address || "").toLowerCase()}`;
  const currentRequest = listingRequest?.key === requestKey ? listingRequest : null;
  const listingsState = infrastructure === MARKETPLACE_STATE.LIVE ? currentRequest?.status || "loading" : "idle";
  const listings = currentRequest?.listings || EMPTY_LISTINGS;
  const indexError = currentRequest?.error || "";

  useEffect(() => {
    if (infrastructure !== MARKETPLACE_STATE.LIVE) return undefined;
    const controller = new AbortController();
    fetchIndexedListings({ chainId: MARKETPLACE_CONFIG.chainId, status: "ACTIVE", signal: controller.signal })
      .then((rows) => {
        setListingRequest({ key: requestKey, status: "ready", listings: rows, error: "" });
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setListingRequest({ key: requestKey, status: "error", listings: [], error: error?.message || "The marketplace index is unavailable." });
      });
    return () => controller.abort();
  }, [infrastructure, requestKey]);

  // The hero artwork is the admin-set marketplace asset only, never an
  // edition, release, token or listing image.
  useEffect(() => {
    const controller = new AbortController();
    fetchMarketplacePresentation({ signal: controller.signal })
      .then(setPresentation)
      .catch((error) => { if (error?.name !== "AbortError") setPresentation(null); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const loadVolume = async () => {
      try {
        const next = await fetchMarketplaceVolume({ signal: controller.signal });
        if (active) setVolume(next);
      } catch (error) {
        if (error?.name !== "AbortError" && active) setVolume(null);
      }
    };
    const refreshOnAuthoritativeEvent = () => { void loadVolume(); };
    void loadVolume();
    window.addEventListener("void:marketplace-volume-updated", refreshOnAuthoritativeEvent);
    document.addEventListener("visibilitychange", refreshOnAuthoritativeEvent);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("void:marketplace-volume-updated", refreshOnAuthoritativeEvent);
      document.removeEventListener("visibilitychange", refreshOnAuthoritativeEvent);
    };
  }, []);

  const secondary = resolveSecondaryStatus({ infrastructure, listingsState });
  const liveListings = useMemo(
    () => secondary === MARKETPLACE_STATE.LIVE ? listings.filter(listingIsDisplayable) : [],
    [listings, secondary],
  );
  const listedEditions = useMemo(() => editions
    .map((item) => ({ item, listings: listingsForEdition(liveListings, item.edition) }))
    .filter((entry) => entry.listings.length > 0), [editions, liveListings]);
  const heroImage = marketplaceHeroImage(presentation);

  const secondarySection = (
    <section aria-labelledby="secondary-listings-heading">
      <SectionHead id="secondary-listings-heading" eyebrow="II · Secondhand" title="Secondary collector listings">
        A secondhand pressing appears only when a real listing is confirmed. Empty means no pressing is offered — not a hidden catalog.
      </SectionHead>
      {secondary === MARKETPLACE_STATE.UNAVAILABLE ? (
        <EmptyRail title="Listings unavailable">The authoritative listing index could not be reached. No offers are shown.</EmptyRail>
      ) : secondary !== MARKETPLACE_STATE.LIVE ? (
        <EmptyRail title="Secondary market not yet live">No secondary offers are displayed until the configured marketplace index is live.</EmptyRail>
      ) : listingsState === "loading" ? (
        <p role="status" className="vc-card-meta">Loading index-confirmed listings…</p>
      ) : listedEditions.length > 0 ? (
        <div className="vc-market-grid">
          {listedEditions.map(({ item, listings: editionListings }) => (
            <SecondaryListingCard key={`indexed-${item.edition.id}`} item={item} listings={editionListings} owned={editionOwnedByWallet(item, wallet)} catalog={catalog} />
          ))}
        </div>
      ) : (
        <EmptyRail title="No active listings">There are no secondary listings right now. Nothing is invented in their place.</EmptyRail>
      )}
      {indexError && <p role="alert" style={{ color: "var(--vc-crimson)", marginTop: 14 }}>{indexError}</p>}
    </section>
  );

  return (
    <section>
      <header className={heroImage ? "vc-market-hero-bleed" : "vc-market-mast"}>
        {heroImage && <div className="vc-market-hero-bg" style={{ backgroundImage: `url("${heroImage}")` }} aria-hidden />}
        {heroImage && <div className="vc-market-hero-shade" aria-hidden />}
        <div className="vc-market-hero-copy">
          <Eyebrow red>† Secondary market</Eyebrow>
          <h1 className="vc-market-hero-title">Marketplace</h1>
          <p className="vc-market-hero-lede">Buy from and sell to other holders. New editions to collect are on Discover.</p>
          {volume && <div className="vc-market-volume" aria-label="Overall volume">
            <Eyebrow>Overall volume</Eyebrow>
            <strong>{formatWeiAsAvax(volume.overallVolumeWei) || "—"}</strong>
          </div>}
          <QuietStatus secondary={marketplaceSecondaryAvailability(secondary)} />
          <details className="vc-colophon"><summary>Index note</summary><p>{INDEX_NOTE[secondary] || INDEX_NOTE[MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE]}</p></details>
          <MarketplaceHeroEditor current={presentation?.heroArtwork || ""} onSaved={setPresentation} />
        </div>
      </header>

      <div style={contentShell}>
        {secondarySection}
      </div>
    </section>
  );
}
