import { useState, useEffect } from "react";
import { Link, NavLink } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { VOID_LIVE } from "../data.js";
import { Btn } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useReviewerNotifications } from "../lib/reviewer-notifications-context.js";

const LINKS = [
  ["DISCOVER", "/discover"],
  ["MARKETPLACE", "/marketplace"],
  ["ARTISTS", "/artists"],
  ["VERIFY", "/verify"],
  ["COLLECTION", "/collection"],
  ["STUDIO", "/studio"],
];

export const REVIEWER_NAV_LABEL = "REVIEW APPLICATIONS";
export const REVIEWER_NAV_PATH = "/verify/review";

// Count badge beside the reviewer link. Hidden at zero so the header stays
// quiet when nothing needs attention.
function ReviewerBadge({ count }) {
  if (!Number.isFinite(count) || count <= 0) return null;
  const label = `${count} ${count === 1 ? "application" : "applications"} awaiting review`;
  return (
    <span className="vc-nav-badge" role="status" aria-label={label} title={label} data-testid="reviewer-badge">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Nav({ onMint }) {
  const [scrolled, setScrolled] = useState(false);
  const notifications = useReviewerNotifications();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const solid = scrolled || menuOpen;
  const links = [
    ...LINKS,
    ...(VOID_LIVE ? [["COVENANT", "/covenant"]] : []),
    // Only an authorized artist-verification reviewer wallet sees this.
    ...(notifications.reviewer ? [[REVIEWER_NAV_LABEL, REVIEWER_NAV_PATH]] : []),
  ];
  const badge = (path) => (path === REVIEWER_NAV_PATH ? <ReviewerBadge count={notifications.count} /> : null);

  return (
    <nav
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        padding: "16px clamp(16px, 4vw, 32px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: solid ? "rgba(0,0,0,0.92)" : "rgba(0,0,0,0.6)",
        backdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--vc-ash)",
        transition: "background 220ms cubic-bezier(0.6,0,0.2,1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}>
          <img src="/assets/VoidcallerLogo.gif" alt="" style={{ width: 32, height: 32, display: "block" }} />
          <img src="/assets/voidcaller_wordmark.png" alt="VOIDCALLER" style={{ height: 22, width: "auto", display: "block" }} />
        </Link>
        <div className="vc-nav-links" style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {links.map(([label, path]) => (
            <NavLink key={label} to={path} end={path === "/"} className="vc-navlink">
              {label}
              {badge(path)}
            </NavLink>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="vc-nav-cta" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <WalletButton />
          <Btn onClick={onMint} style={{ whiteSpace: "nowrap" }}>CLAIM A RELIC</Btn>
        </span>
        <button
          className="vc-nav-burger"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
            background: "transparent",
            border: "1px solid var(--vc-ash)",
            color: "var(--vc-bone)",
            cursor: "pointer",
          }}
        >
          {menuOpen ? <X size={20} strokeWidth={1.75} /> : <Menu size={20} strokeWidth={1.75} />}
        </button>
      </div>

      {menuOpen && (
        <div
          className="vc-nav-menu"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "rgba(0,0,0,0.96)",
            backdropFilter: "blur(14px)",
            borderBottom: "1px solid var(--vc-ash)",
            padding: "12px clamp(16px, 4vw, 32px) 28px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {links.map(([label, path]) => (
            <NavLink
              key={label}
              to={path}
              end={path === "/"}
              className="vc-navlink vc-navlink-mobile"
              onClick={() => setMenuOpen(false)}
              style={{ padding: "14px 0", minHeight: 48, borderBottom: "1px solid var(--vc-ash)", fontSize: 18 }}
            >
              {label}
              {badge(path)}
            </NavLink>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18 }}>
            <WalletButton compact />
            <Btn onClick={() => { setMenuOpen(false); onMint(); }} style={{ whiteSpace: "nowrap" }}>CLAIM A RELIC</Btn>
          </div>
        </div>
      )}
    </nav>
  );
}
