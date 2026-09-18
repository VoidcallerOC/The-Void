import { Link } from "react-router-dom";
import { MARKETPLACE_STATE, marketplaceStatusLabel } from "../lib/marketplace-surface.js";

const tones = {
  [MARKETPLACE_STATE.LIVE]: { color: "#fff", background: "var(--vc-blood)", border: "var(--vc-blood)" },
  [MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE]: { color: "var(--vc-bone-dim)", background: "transparent", border: "var(--vc-ash)" },
  [MARKETPLACE_STATE.UNAVAILABLE]: { color: "var(--vc-bone-dim)", background: "transparent", border: "var(--vc-ash)" },
};

export function MarketplaceStatusBadge({ status, pulse = status === MARKETPLACE_STATE.LIVE }) {
  const tone = tones[status] || tones[MARKETPLACE_STATE.UNAVAILABLE];
  const label = marketplaceStatusLabel(status);
  return (
    <span
      className="vc-market-badge"
      title={status}
      style={{
        fontFamily: "var(--font-body)",
        fontWeight: 700,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        padding: "5px 10px",
        border: `1px solid ${tone.border}`,
        color: tone.color,
        background: tone.background,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {pulse && (
        <span
          style={{
            width: 6,
            height: 6,
            background: "var(--vc-ember)",
            borderRadius: 999,
            boxShadow: "0 0 8px var(--vc-ember)",
            animation: "vc-pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
      {label}
    </span>
  );
}

export function MarketplaceStatusBanner({ status, title, children, actions = [] }) {
  return (
    <aside
      className="vc-market-note"
      style={{
        border: "1px solid var(--vc-ash)",
        background: "var(--vc-abyss)",
        padding: "18px 20px",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <MarketplaceStatusBadge status={status} />
        {title && <strong style={{ fontFamily: "var(--font-body)", fontSize: 14, letterSpacing: "0.08em", textTransform: "uppercase" }}>{title}</strong>}
      </div>
      <div style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65, maxWidth: 720 }}>{children}</div>
      {actions.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {actions.map((action) => (
            <Link
              key={action.to + action.label}
              to={action.to}
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                border: "1px solid var(--vc-bone-dim)",
                color: "var(--vc-bone)",
                padding: "11px 16px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                textDecoration: "none",
              }}
            >
              {action.label}
            </Link>
          ))}
        </div>
      )}
    </aside>
  );
}
