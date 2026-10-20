import { useEffect, useMemo, useSyncExternalStore, Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Grain, Scanlines } from "./Overlays.jsx";
import { VoidStarfield } from "./VoidStarfield.jsx";
import { Nav } from "./Nav.jsx";
import { Footer } from "./Footer.jsx";
import { StickyPlayer } from "./StickyPlayer.jsx";
import { WalletProvider } from "../lib/WalletContext.jsx";
import { useMarketplaceCatalogs, withOwnableDuplicates } from "../lib/catalog-source.js";
import { buildMarketplaceOwnershipConfig } from "../lib/marketplace-ownership.js";
import { ReviewerNotificationsProvider } from "../lib/ReviewerNotificationsProvider.jsx";
import { PreviewHostBridge } from "./PreviewHostBridge.jsx";
import { getPageTitleOverride, pageTitle, subscribePageTitleOverride } from "../lib/page-title.js";
import { VOID_LIVE } from "../data.js";

// Same gates as the route table in App.jsx.
const ROUTE_FLAGS = Object.freeze({ voidLive: VOID_LIVE, summitDemo: import.meta.env.VITE_SUMMIT_DEMO === "true" || import.meta.env.VITE_SUMMIT_DEMO === "1" });

// Minimal in-theme placeholder shown while a lazily-loaded section chunk
// is fetched. Sized to the viewport so the footer doesn't jump up.
function SectionFallback() {
  return (
    <div
      aria-hidden
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.3em",
        textTransform: "uppercase",
        color: "var(--vc-bone-dim)",
        opacity: 0.5,
      }}
    >
      †
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);
  return null;
}

// The document title names the current page (and the record, artist, edition or experience it
// shows) so the tab, history list and bookmarks distinguish routes that share a layout.
export function DocumentTitle({ catalog }) {
  const { pathname } = useLocation();
  const override = useSyncExternalStore(subscribePageTitleOverride, getPageTitleOverride, getPageTitleOverride);
  useEffect(() => {
    document.title = override || pageTitle(pathname, catalog, ROUTE_FLAGS);
  }, [pathname, catalog, override]);
  return null;
}

// Persistent shell — Nav, Footer, and the sticky audio bar stay mounted across
// route changes so playback continues as you navigate.
export function Layout() {
  const catalog = useMarketplaceCatalogs();
  const ownershipConfig = useMemo(() => buildMarketplaceOwnershipConfig(withOwnableDuplicates(catalog).editions), [catalog]);
  return (
    <WalletProvider collectionConfig={ownershipConfig}>
      <ReviewerNotificationsProvider>
        <PreviewHostBridge />
        <ScrollToTop />
        <DocumentTitle catalog={catalog} />
        {/* The whole shell is one isolated stacking context so the ambient
            starfield (z-index -1) sits above the black page ground and beneath
            every page, the nav, footer and player. */}
        <div className="vc-starfield-host">
        <VoidStarfield />
        <Grain />
        <Scanlines />
        <Nav />
        {/* Each route fills the viewport so short pages don't expose the footer
            on load — content centers vertically; taller pages just grow. */}
        <main className="vc-main">
          <Suspense fallback={<SectionFallback />}>
            <Outlet context={{ catalog }} />
          </Suspense>
        </main>
        <Footer />
        <StickyPlayer />
        </div>
      </ReviewerNotificationsProvider>
    </WalletProvider>
  );
}
