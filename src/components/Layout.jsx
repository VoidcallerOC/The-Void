import { useEffect, useMemo, Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Grain, Scanlines } from "./Overlays.jsx";
import { Nav } from "./Nav.jsx";
import { Footer } from "./Footer.jsx";
import { StickyPlayer } from "./StickyPlayer.jsx";
import { WalletProvider } from "../lib/WalletContext.jsx";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { buildMarketplaceOwnershipConfig } from "../lib/marketplace-ownership.js";
import { ReviewerNotificationsProvider } from "../lib/ReviewerNotificationsProvider.jsx";
import { PreviewHostBridge } from "./PreviewHostBridge.jsx";

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

// Persistent shell — Nav, Footer, and the sticky audio bar stay mounted across
// route changes so playback continues as you navigate.
export function Layout() {
  const catalog = useMarketplaceCatalogs();
  const ownershipConfig = useMemo(() => buildMarketplaceOwnershipConfig(catalog.editions), [catalog.editions]);
  return (
    <WalletProvider collectionConfig={ownershipConfig}>
      <ReviewerNotificationsProvider>
        <PreviewHostBridge />
        <ScrollToTop />
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
      </ReviewerNotificationsProvider>
    </WalletProvider>
  );
}
