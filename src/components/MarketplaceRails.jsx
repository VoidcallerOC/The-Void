import { Link } from "react-router-dom";
import { MarketplaceStatusBanner } from "./MarketplaceStatus.jsx";
import { ghostBtn } from "../lib/marketplace-chrome.js";
import {
  marketplaceCopy,
  marketplaceStatusLabel,
  primaryCollectForEdition,
  resolveInfrastructureStatus,
  resolveSecondaryStatus,
} from "../lib/marketplace-surface.js";

export function DiscoveryMarketplaceCallout() {
  const copy = marketplaceCopy();
  return (
    <div style={{ margin: "0 0 36px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65, margin: 0 }}>{copy.body}</p>
      <Link to="/marketplace" style={ghostBtn}>Enter marketplace</Link>
    </div>
  );
}

export function ReleaseMarketplaceStrip({ release, editions = [] }) {
  const primary = editions[0] ? primaryCollectForEdition(editions[0]) : null;
  return (
    <section style={{ marginTop: 56, borderTop: "1px solid var(--vc-ash)", paddingTop: 32 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Link to={`/marketplace?release=${release.id}`} style={ghostBtn}>View on marketplace</Link>
        {primary && <Link to={primary.href} style={ghostBtn}>{primary.label}</Link>}
      </div>
    </section>
  );
}

export function EditionMarketplaceRail() {
  const infrastructure = resolveInfrastructureStatus();
  const secondary = resolveSecondaryStatus({ infrastructure });
  return (
    <section style={{ marginTop: 40 }}>
      <MarketplaceStatusBanner status={secondary} title="Secondary market">
        <p style={{ margin: 0 }}>
          {marketplaceStatusLabel(secondary) === "LIVE"
            ? "Active indexed listings for this edition appear when the live index has them."
            : "Secondary listing and purchase are not yet live. No offers are shown or invented."}
        </p>
      </MarketplaceStatusBanner>
    </section>
  );
}

export function CollectionMarketplaceCallout() {
  const secondary = resolveSecondaryStatus();
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
          Owned editions can be listed when secondary collection is live. Until then this remains {marketplaceStatusLabel(secondary).toLowerCase()}.
        </p>
      </MarketplaceStatusBanner>
    </div>
  );
}
