import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { EditionCard, EmptyRail, QuietStatus, SecondaryListingCard, SectionHead } from "./MarketplaceCards.jsx";
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
  flattenMarketplaceEditions,
  formatWeiAsAvax,
  listingIsDisplayable,
  listingsForEdition,
  marketplaceSecondaryAvailability,
  marketplaceCopy,
  resolveInfrastructureStatus,
  releaseScopedFirst,
  resolveSecondaryStatus,
} from "../lib/marketplace-surface.js";

const PUBLIC_RELEASE_STATES = new Set(["published", "minted"]);
const PUBLIC_EDITION_STATES = new Set(["published", "available", "minted"]);
const EMPTY_LISTINGS = [];

function hasPublicLifecycle(item) {
  const releaseStatus = String(item.release?.status || "").toLowerCase();
  const editionStatus = String(item.edition?.status || "").toLowerCase();
  return PUBLIC_RELEASE_STATES.has(releaseStatus) && PUBLIC_EDITION_STATES.has(editionStatus);
}

function editionOwnedByWallet(item, wallet) {
  const chainKey = item.chain?.key;
  const ownedTokens = chainKey ? wallet.owned?.[chainKey] : null;
  return Boolean(ownedTokens?.has)
    && (item.edition.tokenIds || []).some((tokenId) => ownedTokens.has(String(tokenId)) || ownedTokens.has(tokenId));
}

export function MarketplacePage() {
  const [params] = useSearchParams();
  const focusRelease = params.get("release") || "";
  const focusEdition = params.get("edition") || "";
  const rawCatalog = useMarketplaceCatalogs();
  const catalog = useMemo(() => collapsePublicCatalog(rawCatalog), [rawCatalog]);
  const wallet = useWallet();
  const infrastructure = resolveInfrastructureStatus();
  const copy = marketplaceCopy(infrastructure);
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
  const listedEditionIds = useMemo(() => new Set(listedEditions.map(({ item }) => item.edition.id)), [listedEditions]);
  const officialEditions = useMemo(
    () => releaseScopedFirst(editions.filter((item) => item.primary.availability === "available" && !listedEditionIds.has(item.edition.id))),
    [editions, listedEditionIds],
  );
  const heroImage = marketplaceHeroImage(presentation);

  return (
    <section>
      <header className={heroImage ? "vc-market-hero-bleed" : "vc-market-mast"}>
        {heroImage && <div className="vc-market-hero-bg" style={{ backgroundImage: `url("${heroImage}")` }} aria-hidden />}
        {heroImage && <div className="vc-market-hero-shade" aria-hidden />}
        <div className="vc-market-hero-copy">
          <Eyebrow red>† The catalog</Eyebrow>
          <h1 className="vc-market-hero-title">Releases</h1>
          <p className="vc-market-hero-lede">Collect the pressing. Hear what it unlocks. Provenance stays on the colophon.</p>
          {volume && <div className="vc-market-volume" aria-label="Overall volume">
            <Eyebrow>Overall volume</Eyebrow>
            <strong>{formatWeiAsAvax(volume.overallVolumeWei) || "—"}</strong>
          </div>}
          <QuietStatus primary="Published catalog" secondary={marketplaceSecondaryAvailability(secondary)} />
          <details className="vc-colophon"><summary>Index note</summary><p>{copy.body}</p></details>
          <MarketplaceHeroEditor current={presentation?.heroArtwork || ""} onSaved={setPresentation} />
        </div>
      </header>

      <div style={contentShell}>
        <section aria-label="The shelf">
          <SectionHead eyebrow="The shelf" title="Pressings">
            Every public pressing. Relic and rehearsal are marked. Collect only appears when a pressing can actually be taken.
          </SectionHead>
          {editions.filter((item) => !officialEditions.some((official) => official.edition.id === item.edition.id) && !listedEditionIds.has(item.edition.id)).length > 0 ? (
            <div className="vc-market-grid">
              {editions.filter((item) => !officialEditions.some((official) => official.edition.id === item.edition.id) && !listedEditionIds.has(item.edition.id)).map((item) => (
                <EditionCard key={`shelf-${item.edition.id}`} item={item} owned={editionOwnedByWallet(item, wallet)} />
              ))}
            </div>
          ) : (
            <EmptyRail title="The shelf is empty">No held or completed pressings sit outside the collectable list.</EmptyRail>
          )}
        </section>
        <section aria-labelledby="official-editions-heading">
          <SectionHead id="official-editions-heading" eyebrow="I · The pressings" title="Official editions available to collect">
            Each official pressing appears once. The relic and the rehearsal are marked apart. A sold-out, ended or not-yet-started pressing is not offered as collectable. An open edition stays collectable until its sale ends.
          </SectionHead>
          {officialEditions.length > 0 ? (
            <div className="vc-market-grid">
              {officialEditions.map((item) => (
                <EditionCard key={item.edition.id} item={item} owned={editionOwnedByWallet(item, wallet)} />
              ))}
            </div>
          ) : (
            <EmptyRail title={editions.some((item) => item.primary.availability === "available") ? "Official editions grouped below" : "No official editions available"}>
              {editions.some((item) => item.primary.availability === "available")
                ? "Every available official edition currently has an active indexed offer, so its single card and primary collect action are shown with that offer below."
                : "There are no published primary editions available to collect in this catalog view."}
            </EmptyRail>
          )}
        </section>

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
                <SecondaryListingCard key={`indexed-${item.edition.id}`} item={item} listings={editionListings} owned={editionOwnedByWallet(item, wallet)} />
              ))}
            </div>
          ) : (
            <EmptyRail title="No active listings">No pressings available. The index confirms no secondhand offer. Nothing is invented in its place.</EmptyRail>
          )}
          {indexError && <p role="alert" style={{ color: "var(--vc-crimson)", marginTop: 14 }}>{indexError}</p>}
        </section>
      </div>
    </section>
  );
}
