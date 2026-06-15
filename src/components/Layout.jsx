import { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Grain, Scanlines } from "./Overlays.jsx";
import { Nav } from "./Nav.jsx";
import { Footer } from "./Footer.jsx";
import { StickyPlayer } from "./StickyPlayer.jsx";
import { MintModal } from "./MintModal.jsx";
import { WalletProvider } from "../lib/WalletContext.jsx";

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
        <Outlet context={{ onMint }} />
      </main>
      <Footer />
      <StickyPlayer />
      <MintModal open={mintOpen} onClose={() => setMintOpen(false)} />
    </WalletProvider>
  );
}
