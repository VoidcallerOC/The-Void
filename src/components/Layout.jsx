import { useState, useEffect, Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Grain, Scanlines } from "./Overlays.jsx";
import { Nav } from "./Nav.jsx";
import { Footer } from "./Footer.jsx";
import { StickyPlayer } from "./StickyPlayer.jsx";
import { MintModal } from "./MintModal.jsx";
import { WalletProvider } from "../lib/WalletContext.jsx";

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

// Persistent shell — Nav, Footer, the sticky audio bar and mint modal stay
// mounted across route changes so playback continues as you navigate.
export function Layout() {
  const [mintOpen, setMintOpen] = useState(false);
  const onMint = () => setMintOpen(true);
  return (
    <WalletProvider>
      <ScrollToTop />
      <Grain />
      <Scanlines />
      <Nav onMint={onMint} />
      {/* Each route fills the viewport so short pages don't expose the footer
          on load — content centers vertically; taller pages just grow. */}
      <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <Suspense fallback={<SectionFallback />}>
          <Outlet context={{ onMint }} />
        </Suspense>
      </main>
      <Footer />
      <StickyPlayer />
      <MintModal open={mintOpen} onClose={() => setMintOpen(false)} />
    </WalletProvider>
  );
}
