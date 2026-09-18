import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { MarketplaceStatusBadge, MarketplaceStatusBanner } from "./MarketplaceStatus.jsx";
import { fetchIndexedListings } from "../lib/marketplace-api.js";
import { MARKETPLACE_CONFIG } from "../lib/marketplace.js";
import {
  MARKETPLACE_STATE,
  formatWeiAsAvax,
  listingsForEdition,
  marketplaceCatalog,
  marketplaceCopy,
  resolveInfrastructureStatus,
  resolveSecondaryStatus,
} from "../lib/marketplace-surface.js";

const shell = { maxWidth: 1100, margin: "0 auto", padding: "clamp(120px, 16vw, 180px) clamp(20px, 5vw, 48px)" };
const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24, color: "inherit", textDecoration: "none", display: "block" };
const button = { display: "inline-block", border: "1px solid var(--vc-bone-dim)", color: "var(--vc-bone)", padding: "11px 16px", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", textDecoration: "none" };

export function MarketplacePage() {
  const [params] = useSearchParams();
  const focusRelease = params.get("release") || "";
  const focusEdition = params.get("edition") || "";
  const infrastructure = resolveInfrastructureStatus();
  const copy = marketplaceCopy(infrastructure);
  const catalog = useMemo(() => marketplaceCatalog(), []);
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
        setListings([]);
        setListingsState("error");
        setIndexError(error?.message || "The marketplace index is unavailable.");
      });
    return () => controller.abort();
  }, [infrastructure]);

  const secondary = resolveSecondaryStatus({ infrastructure, listingsState });
  const records = catalog.filter((record) => !focusRelease || record.release.id === focusRelease);

  return (
    <section style={shell}>
      <header style={{ marginBottom: 36 }}>
        <Eyebrow red>† MARKETPLACE</Eyebrow>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", lineHeight: 0.92, textTransform: "uppercase", margin: "16px 0" }}>{copy.title}</h1>
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.7, margin: 0 }}>{copy.body}</p>
      </header>

      <MarketplaceStatusBanner
        status={secondary}
        title={copy.eyebrow}
        actions={[
          { to: "/discover", label: "Open discovery" },
          { to: "/collection", label: "My collection" },
        ]}
      >
        <p style={{ margin: "0 0 8px" }}>Artist → Release → Editions → Experience → Collect. Marketplace is the secondary-collection layer around that path — not a generic token exchange.</p>
        <p style={{ margin: 0 }}>Secondary trading is {secondary === MARKETPLACE_STATE.LIVE ? "reading the live index only." : "not live-certified. No listings, orders, or trades are simulated."}</p>
        {indexError && <p style={{ margin: "8px 0 0", color: "var(--vc-crimson)" }}>{indexError}</p>}
      </MarketplaceStatusBanner>

      <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", color: "var(--vc-bone-dim)", textTransform: "uppercase", margin: "28px 0 0" }}>
        Secondary offers shown: {infrastructure === MARKETPLACE_STATE.LIVE && listingsState === "ready" ? listings.length : 0} indexed · never invented
      </p>

      <div style={{ display: "grid", gap: 48, marginTop: 40 }}>
        {records.map((record) => (
          <article key={record.release.id}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 280px) minmax(0, 1fr)", gap: 24, alignItems: "start" }} className="vc-grid-2col">
              <img src={record.release.artwork} alt={`${record.release.title} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", border: "1px solid var(--vc-ash)" }} />
              <div>
                <MarketplaceStatusBadge status={record.editions[0]?.primary.status || MARKETPLACE_STATE.UNAVAILABLE} pulse={false} />
                <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".14em", color: "var(--vc-crimson)", textTransform: "uppercase", margin: "14px 0 6px" }}>{record.artist?.name} · {record.release.status}</p>
                <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 6vw, 52px)", lineHeight: 0.95, textTransform: "uppercase", margin: "0 0 12px" }}>{record.release.title}</h2>
                <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65, maxWidth: 640 }}>{record.release.description}</p>
                <p style={{ color: "var(--vc-bone-dim)", fontSize: 14 }}>{record.release.subtitle}</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
                  <Link to={`/release/${record.release.id}`} style={button}>Open release</Link>
                  <Link to={`/artist/${record.artist?.id}`} style={button}>{record.artist?.name}</Link>
                </div>
              </div>
            </div>

            <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, margin: "32px 0 14px", textTransform: "uppercase" }}>Editions</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
              {record.editions.filter((item) => !focusEdition || item.edition.id === focusEdition).map((item) => {
                const offers = listingsForEdition(listings, item.edition);
                return (
                  <div key={item.edition.id} style={card}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                      <MarketplaceStatusBadge status={item.primary.status} pulse={false} />
                      <MarketplaceStatusBadge status={secondary} pulse={secondary === MARKETPLACE_STATE.LIVE} />
                    </div>
                    <h4 style={{ fontFamily: "var(--font-display)", fontSize: 26, margin: "0 0 8px", textTransform: "uppercase" }}>{item.edition.title}</h4>
                    <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.6 }}>{item.edition.description}</p>
                    <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".08em" }}>
                      {item.edition.supply || "Open supply"} · {item.edition.chain} · {item.edition.tier}
                    </p>
                    <Eyebrow>Collector receives</Eyebrow>
                    <ul style={{ color: "var(--vc-bone-dim)", lineHeight: 1.8, paddingLeft: 18 }}>
                      {(item.edition.includes || []).map((entry) => <li key={entry}>{entry}</li>)}
                    </ul>
                    <Eyebrow>Experiences included</Eyebrow>
                    <div style={{ display: "grid", gap: 8, margin: "10px 0 18px" }}>
                      {item.experiences.length ? item.experiences.map((experience) => (
                        <Link key={experience.id} to={`/experience/${experience.id}`} style={{ color: "var(--vc-bone)", textDecoration: "none" }}>
                          {experience.title}
                          <span style={{ color: "var(--vc-bone-dim)" }}> · {experience.experienceType}</span>
                        </Link>
                      )) : <span style={{ color: "var(--vc-bone-dim)" }}>No attached experiences.</span>}
                    </div>
                    <p style={{ color: "var(--vc-bone)", fontSize: 14, marginBottom: 8 }}>{item.primary.label}</p>
                    <p style={{ color: "var(--vc-bone-dim)", fontSize: 13, lineHeight: 1.55 }}>{item.primary.note}</p>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
                      <Link to={item.primary.href} style={button}>{item.primary.availability === "minted" ? "Open collector experience" : "Primary collect"}</Link>
                      <Link to={`/edition/${item.edition.id}`} style={button}>Edition page</Link>
                    </div>
                    <div style={{ marginTop: 20, borderTop: "1px solid var(--vc-ash)", paddingTop: 16 }}>
                      <Eyebrow>Secondary listings</Eyebrow>
                      {secondary !== MARKETPLACE_STATE.LIVE && (
                        <p style={{ color: "var(--vc-bone-dim)", margin: "10px 0 0" }}>No secondary listings. The marketplace rail is {secondary.toLowerCase()}.</p>
                      )}
                      {secondary === MARKETPLACE_STATE.LIVE && offers.length === 0 && (
                        <p style={{ color: "var(--vc-bone-dim)", margin: "10px 0 0" }}>The live index has no active listings for this edition.</p>
                      )}
                      {offers.map((listing) => (
                        <p key={listing.listingId || listing.id} style={{ color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                          {listing.amount} remaining · {formatWeiAsAvax(listing.price) || "Price indexed"} · {listing.status}
                        </p>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
