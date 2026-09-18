import { Link } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { MarketplaceStatusBadge, MarketplaceStatusBanner } from "./MarketplaceStatus.jsx";
import { ListingPanel } from "./ListingPanel.jsx";
import { PurchasePanel } from "./PurchasePanel.jsx";
import {
  MARKETPLACE_STATE,
  marketplaceCopy,
  primaryCollectForEdition,
  resolveInfrastructureStatus,
  resolveSecondaryStatus,
} from "../lib/marketplace-surface.js";

const button = { display: "inline-block", border: "1px solid var(--vc-bone-dim)", color: "var(--vc-bone)", padding: "11px 16px", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", textDecoration: "none" };

export function DiscoveryMarketplaceCallout() {
  const infrastructure = resolveInfrastructureStatus();
  const secondary = resolveSecondaryStatus({ infrastructure });
  const copy = marketplaceCopy(infrastructure);
  return (
    <div style={{ margin: "0 0 36px" }}>
      <MarketplaceStatusBanner
        status={secondary}
        title="Secondary collection"
        actions={[{ to: "/marketplace", label: "Enter marketplace" }]}
      >
        <p style={{ margin: 0 }}>{copy.body} Discovery stays music-first: artists, releases, editions, and experiences. Marketplace is the secondary layer around those records.</p>
      </MarketplaceStatusBanner>
    </div>
  );
}

export function ReleaseMarketplaceStrip({ release, editions = [] }) {
  const infrastructure = resolveInfrastructureStatus();
  const secondary = resolveSecondaryStatus({ infrastructure });
  const primary = editions[0] ? primaryCollectForEdition(editions[0]) : null;
  return (
    <section style={{ marginTop: 56, borderTop: "1px solid var(--vc-ash)", paddingTop: 32 }}>
      <Eyebrow red>Collect</Eyebrow>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0 18px" }}>
        <MarketplaceStatusBadge status={primary?.status || MARKETPLACE_STATE.UNAVAILABLE} pulse={false} />
        <MarketplaceStatusBadge status={secondary} />
      </div>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 36, textTransform: "uppercase", margin: "0 0 12px" }}>Primary and secondary collection</h2>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65 }}>
        Collect this release through its editions. Primary collection is the music-native mint or collector path.
        Secondary listings appear on the Marketplace only when the live index actually has them.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        <Link to={`/marketplace?release=${release.id}`} style={button}>View on marketplace</Link>
        {primary && <Link to={primary.href} style={button}>{primary.label}</Link>}
      </div>
    </section>
  );
}

export function EditionMarketplaceRail({ edition, release, artist, experiences = [] }) {
  const infrastructure = resolveInfrastructureStatus();
  const secondary = resolveSecondaryStatus({ infrastructure });
  const primary = primaryCollectForEdition(edition);
  return (
    <section style={{ marginTop: 56 }}>
      <Eyebrow red>Collect this edition</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 36, textTransform: "uppercase", margin: "12px 0 16px" }}>Artist · Release · Edition</h2>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65, marginBottom: 20 }}>
        {artist?.name} · {release?.title} · {edition.title}. Experiences included: {experiences.length ? experiences.map((item) => item.title).join(", ") : "none attached"}.
      </p>
      <MarketplaceStatusBanner
        status={primary.status}
        title={primary.label}
        actions={[
          { to: primary.href, label: primary.availability === "minted" ? "Open collector experience" : "Primary collect" },
          { to: `/marketplace?edition=${edition.id}`, label: "Marketplace" },
        ]}
      >
        <p style={{ margin: 0 }}>{primary.note}</p>
      </MarketplaceStatusBanner>
      <div style={{ marginTop: 16 }}>
        <MarketplaceStatusBanner status={secondary} title="Secondary collection">
          <p style={{ margin: 0 }}>
            {secondary === MARKETPLACE_STATE.LIVE
              ? "Active indexed listings for this edition appear below. Token identifiers stay in the settlement layer, not the product headline."
              : "Secondary listing and purchase are implemented in the protocol, but they are not live-certified. No offers are shown or invented."}
          </p>
        </MarketplaceStatusBanner>
      </div>
      <PurchasePanel edition={edition} />
      <ListingPanel edition={edition} />
    </section>
  );
}

export function CollectionMarketplaceCallout() {
  const infrastructure = resolveInfrastructureStatus();
  const secondary = resolveSecondaryStatus({ infrastructure });
  return (
    <div style={{ marginTop: 36 }}>
      <MarketplaceStatusBanner
        status={secondary}
        title="List from your collection"
        actions={[
          { to: "/marketplace", label: "Open marketplace" },
          { to: "/reliquary", label: "Open reliquary" },
        ]}
      >
        <p style={{ margin: 0 }}>
          Owned editions can be listed when secondary collection is live. Until a reviewed marketplace contract is configured,
          this remains {secondary.toLowerCase()} — your collector experience and Summit collect path are unchanged.
        </p>
      </MarketplaceStatusBanner>
    </div>
  );
}
