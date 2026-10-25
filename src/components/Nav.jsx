import { useState, useEffect } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { VOID_LIVE } from "../data.js";
import { WalletButton } from "./WalletButton.jsx";
import { XAccountLink } from "./XAccountLink.jsx";
import { BrandLogo } from "./BrandLogo.jsx";
import { useReviewerNotifications } from "../lib/reviewer-notifications-context.js";

const LINKS = [
  ["DISCOVER", "/discover"],
  ["MARKETPLACE", "/marketplace"],
  ["CLAIM", "/claim"],
  ["ARTISTS", "/artists"],
  ["VERIFY", "/verify"],
  ["COLLECTION", "/my-collection"],
  ["ARTIST STUDIO", "/studio"],
];

// COLLECTION opens the collector's own collection; the catalog pages under /collection stay part of that section.
const inCollectionSection = (linkPath, pathname) => linkPath === "/my-collection" && /^\/collection(\/|$)/.test(pathname);

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

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const notifications = useReviewerNotifications();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  // Any route change closes the mobile menu: the logo, footer and in-page links, and browser
  // back/forward all navigate without a menu-item click. Left open, the full-width menu hid the
  // new page so the site looked unchanged (reproduced on production at 375px).
  const [menuRoute, setMenuRoute] = useState(location.key);
  if (menuRoute !== location.key) {
    setMenuRoute(location.key);
    if (menuOpen) setMenuOpen(false);
  }
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
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
  // Collector destinations first, then the artist-facing pair (VERIFY, ARTIST STUDIO) after a rule.
  // The mobile menu lists the same links in the same order as the desktop header.
  const isSecondary = ([, path]) => ["/verify", "/studio"].includes(path);
  const primaryLinks = links.filter((link) => !isSecondary(link));
  const secondaryLinks = links.filter(isSecondary);
  const orderedLinks = [...primaryLinks, ...secondaryLinks];

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
        backdropFilter: "none",
        borderBottom: "1px solid var(--vc-ash)",
        transition: "background 220ms cubic-bezier(0.6,0,0.2,1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", textDecoration: "none" }}>
          <BrandLogo />
        </Link>
        <div className="vc-nav-links" style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {primaryLinks.map(([label, path]) => (
            <NavLink key={label} to={path} end={path === "/"} className={({ isActive }) => `vc-navlink${isActive || inCollectionSection(path, location.pathname) ? " active" : ""}`}>
              {label}
              {badge(path)}
            </NavLink>
          ))}
          <span className="vc-nav-rule" aria-hidden="true" />
          {secondaryLinks.map(([label, path]) => (
            <NavLink key={label} to={path} end={path === "/"} className="vc-navlink vc-nav-secondary">
              {label}
              {badge(path)}
            </NavLink>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="vc-nav-cta vc-nav-wallet" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <XAccountLink variant="nav" />
          <WalletButton />
        </span>
        <button
          className="vc-nav-burger"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="vc-mobile-menu"
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
          id="vc-mobile-menu"
          className="vc-nav-menu"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "rgba(0,0,0,0.96)",
            backdropFilter: "none",
            borderBottom: "1px solid var(--vc-ash)",
            padding: "12px clamp(16px, 4vw, 32px) 28px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {orderedLinks.map(([label, path]) => (
            <NavLink
              key={label}
              to={path}
              end={path === "/"}
              className={({ isActive }) => `vc-navlink vc-navlink-mobile${isActive || inCollectionSection(path, location.pathname) ? " active" : ""}`}
              onClick={() => setMenuOpen(false)}
              style={{ padding: "14px 0", minHeight: 48, borderBottom: "1px solid var(--vc-ash)", fontSize: 18 }}
            >
              {label}
              {badge(path)}
            </NavLink>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18 }}>
            <XAccountLink variant="nav" />
            <WalletButton compact />
          </div>
        </div>
      )}
    </nav>
  );
}
