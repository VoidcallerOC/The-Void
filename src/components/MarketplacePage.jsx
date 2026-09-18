import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { ArtistCard, EditionCard, EmptyRail, FeaturedReleaseCard, QuietStatus } from "./MarketplaceCards.jsx";
import { fetchIndexedListings } from "../lib/marketplace-api.js";
import { MARKETPLACE_CONFIG } from "../lib/marketplace.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { getCollectorLibrary } from "../lib/collection.js";
import { useWallet } from "../lib/wallet-context.js";
import { artworkFor, ghostBtn, primaryBtn, contentShell } from "../lib/marketplace-chrome.js";
import {
  MARKETPLACE_STATE,
  collectableFirst,
  flattenMarketplaceEditions,
  featuredMarketplaceRecord,
  listingsForEdition,
  marketplaceCatalog,
  marketplaceCopy,
  marketplaceStatusLabel,
  resolveInfrastructureStatus,
  resolveSecondaryStatus,
} from "../lib/marketplace-surface.js";

export function MarketplacePage() {
  const [params] = useSearchParams();
  const focusRelease = params.get("release") || "";
  const focusEdition = params.get("edition") || "";
  const catalog = useMarketplaceCatalogs();
  const wallet = useWallet();
  const infrastructure = resolveInfrastructureStatus();
  const copy = marketplaceCopy(infrastructure);
  const records = useMemo(
    () => collectableFirst(marketplaceCatalog([catalog]).filter((record) => !focusRelease || record.release.id === focusRelease)),
    [catalog, focusRelease],
  );
  const editions = useMemo(
    () => collectableFirst(flattenMarketplaceEditions([catalog]).filter((item) => !focusEdition || item.edition.id === focusEdition)),
    [catalog, focusEdition],
  );
  const [listingsState, setListingsState] = useState(infrastructure === MARKETPLACE_STATE.LIVE ? "loading" : "idle");
  const [listings, setListings] = useState([]);
  const [indexError, setIndexError] = useState("");

  useEffect(() => {
    if (infrastructure !== MARKETPLACE_STATE.LIVE) return undefined;
    const controller = new AbortController();
    fetchIndexedListings({ chainId: MARKETPLACE_CONFIG.chainId, status: "ACTIVE", signal: controller.signal })
      .then((rows) => {
        setListings(rows);
        setListingsState("ready");
        setIndexError("");
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setListings([]);
        setListingsState("error");
        setIndexError(error?.message || "The marketplace index is unavailable.");
      });
    return () => controller.abort();
  }, [infrastructure]);

  const secondary = resolveSecondaryStatus({ infrastructure, listingsState });
  const featured = featuredMarketplaceRecord(records);
  const featuredEdition = featured?.editions.find((item) => item.primary.availability === "available") || featured?.editions[0];
  const liveListings = secondary === MARKETPLACE_STATE.LIVE ? listings : [];
  const listedEditions = editions.filter((item) => listingsForEdition(liveListings, item.edition).length);
  const library = useMemo(
    () => (wallet.connected ? getCollectorLibrary(catalog, wallet.ownershipRecords || []) : { editions: [] }),
    [catalog, wallet.connected, wallet.ownershipRecords],
  );

  return (
    <section>
      <header className="vc-market-hero-bleed">
        {featured && (
          <div
            className="vc-market-hero-bg"
            style={{ backgroundImage: `url(${artworkFor(featuredEdition?.edition, featured.release)})` }}
            aria-hidden
          />
        )}
        <div className="vc-market-hero-shade" aria-hidden />
        <div className="vc-market-hero-copy">
          <Eyebrow red>† {copy.eyebrow}</Eyebrow>
          <h1 className="vc-market-hero-title">{copy.title}</h1>
          <p className="vc-market-hero-lede">{copy.body}</p>
          {featuredEdition && (
            <div className="vc-market-hero-feature">
              <p className="vc-card-kicker">{featured.artist?.name}</p>
              <p className="vc-market-hero-release">{featured.release.title}</p>
              <p className="vc-card-release">{featuredEdition.edition.title}</p>
              {(featuredEdition.edition.includes || []).length > 0 && (
                <ul className="vc-includes">
                  {featuredEdition.edition.includes.map((entry) => <li key={entry}>{entry}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="vc-market-hero-actions">
            {featuredEdition && (
              <Link to={featuredEdition.primary.href} style={primaryBtn}>
                {featuredEdition.primary.availability === "available" ? "Collect" : featuredEdition.primary.label}
              </Link>
            )}
            {featured && <Link to={`/release/${featured.release.id}`} style={ghostBtn}>Open release</Link>}
            <Link to="/studio?create=edition" style={ghostBtn}>Create edition</Link>
          </div>
          <QuietStatus primary="Certified" secondary={marketplaceStatusLabel(secondary)} />
        </div>
      </header>

      <div style={contentShell}>
        <SectionLabel>Featured / Available releases</SectionLabel>
        <div className="vc-release-rail">
          {records.map((record) => <FeaturedReleaseCard key={record.release.id} record={record} />)}
        </div>

        <SectionLabel>Recently listed</SectionLabel>
        {secondary !== MARKETPLACE_STATE.LIVE && (
          <EmptyRail title="Secondary market · not yet live">
            No secondary listings. Primary collect is live for certified editions. Secondary trading appears here only after a reviewed marketplace contract is configured and indexed.
          </EmptyRail>
        )}
        {secondary === MARKETPLACE_STATE.LIVE && listedEditions.length === 0 && (
          <EmptyRail title="No active listings">
            The live index has no secondary listings right now. Primary collect is still available on certified editions.
          </EmptyRail>
        )}
        {listedEditions.length > 0 && (
          <div className="vc-market-grid">
            {listedEditions.map((item) => (
              <EditionCard key={`listed-${item.edition.id}`} item={item} listings={listingsForEdition(liveListings, item.edition)} secondaryStatus={secondary} />
            ))}
          </div>
        )}
        {indexError && <p style={{ color: "var(--vc-crimson)" }}>{indexError}</p>}

        <SectionLabel>Featured editions</SectionLabel>
        <div className="vc-market-grid">
          {editions.map((item) => (
            <EditionCard
              key={item.edition.id}
              item={item}
              listings={listingsForEdition(liveListings, item.edition)}
              secondaryStatus={secondary}
            />
          ))}
        </div>

        <SectionLabel>From the artists</SectionLabel>
        <div className="vc-market-grid">
          {catalog.artists.map((artist) => (
            <ArtistCard key={artist.id} artist={artist} releases={catalog.releases.filter((release) => release.artistId === artist.id)} />
          ))}
        </div>

        <SectionLabel>Collector activity</SectionLabel>
        {library.editions.length > 0 ? (
          <div className="vc-market-grid">
            {library.editions.map(({ edition, release, artist, quantity }) => (
              <article key={`held-${edition.id}`} className="vc-market-card">
                <img src={artworkFor(edition, release)} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
                <div style={{ padding: 22 }}>
                  <p className="vc-card-kicker">{artist?.name}</p>
                  <h3 className="vc-card-title">{edition.title}</h3>
                  <p className="vc-card-meta">{quantity} owned · from your connected wallet</p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                    <Link to={`/edition/${edition.id}`} style={primaryBtn}>Owned</Link>
                    <Link to="/collection" style={ghostBtn}>My collection</Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyRail title="No public activity feed">
            Collector activity is shown only from indexed on-chain events or a connected wallet's holdings. Nothing is simulated here.
          </EmptyRail>
        )}

        <section className="vc-artist-cta">
          <div>
            <Eyebrow red>For artists</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(36px, 5vw, 56px)", textTransform: "uppercase", lineHeight: 0.95, margin: "12px 0" }}>Publish a new edition</h2>
            <p style={{ color: "var(--vc-bone-dim)", maxWidth: 560, lineHeight: 1.65, margin: 0 }}>
              Artist Studio creates the release, edition, and on-chain relic on the certified Fuji contract.
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Link to="/studio?create=edition" style={primaryBtn}>Create edition</Link>
            <Link to="/studio" style={ghostBtn}>Open artist studio</Link>
          </div>
        </section>
      </div>
    </section>
  );
}

function SectionLabel({ children }) {
  return (
    <h2 className="vc-section-label">
      {children}
    </h2>
  );
}
