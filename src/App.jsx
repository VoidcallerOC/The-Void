import { lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, useOutletContext } from "react-router-dom";
import { Layout } from "./components/Layout.jsx";
import { Hero } from "./components/Hero.jsx";
import { VOID_LIVE } from "./data.js";
import { DiscoverPage, ArtistsPage, ArtistPage, ReleasePage, EditionPage, ExperiencePage, CollectionPage, CollectorsPage } from "./components/PlatformPages.jsx";
import { ArtistStudioPage } from "./components/ArtistStudioPage.jsx";
import { MarketplacePage } from "./components/MarketplacePage.jsx";
import { VerifyApplyPage, VerifyDashboardPage, VerifyLanding, VerifyReceivedPage, VerifyReviewApplicationPage, VerifyReviewQueuePage } from "./components/VerifyPages.jsx";

// Compile-time gate. Vite inlines VITE_* so the Fuji certification page is
// dropped from the production graph unless VITE_SUMMIT_DEMO is explicitly on.
const SUMMIT_DEMO = import.meta.env.VITE_SUMMIT_DEMO === "true" || import.meta.env.VITE_SUMMIT_DEMO === "1";

// Hero is the above-the-fold landing — keep it eager. The rest of the
// sections are split into their own chunks and loaded on navigation.
const Chronicle = lazy(() => import("./components/Chronicle.jsx").then((m) => ({ default: m.Chronicle })));
const TheBleed = lazy(() => import("./components/TheBleed.jsx").then((m) => ({ default: m.TheBleed })));
const Choir = lazy(() => import("./components/Choir.jsx").then((m) => ({ default: m.Choir })));
const Covenant = lazy(() => import("./components/Covenant.jsx").then((m) => ({ default: m.Covenant })));
const Reliquary = lazy(() => import("./components/Reliquary.jsx").then((m) => ({ default: m.Reliquary })));
const FujiIntegrationPage = SUMMIT_DEMO
  ? lazy(() => import("./components/FujiIntegrationPage.jsx").then((m) => ({ default: m.FujiIntegrationPage })))
  : null;

// Thin page wrappers — pull onMint from the Layout's Outlet context where needed.
function HomePage() {
  const { onMint } = useOutletContext();
  return <Hero onMint={onMint} />;
}
function ChroniclePage() {
  return <Chronicle />;
}
function BleedPage() {
  return <TheBleed />;
}
function ChoirPage() {
  return <Choir />;
}
function CovenantPage() {
  return <Covenant />;
}
function ReliquaryPage() {
  return <Reliquary />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="discover" element={<DiscoverPage />} />
          <Route path="marketplace" element={<MarketplacePage />} />
          <Route path="artists" element={<ArtistsPage />} />
          <Route path="artist/:artist" element={<ArtistPage />} />
          <Route path="release/:release" element={<ReleasePage />} />
          <Route path="edition/:edition" element={<EditionPage />} />
          <Route path="experience/:experience" element={<ExperiencePage />} />
          <Route path="studio" element={<ArtistStudioPage />} />
          <Route path="verify" element={<VerifyLanding />} />
          <Route path="verify/apply" element={<VerifyApplyPage />} />
          <Route path="verify/received" element={<VerifyReceivedPage />} />
          <Route path="verify/dashboard" element={<VerifyDashboardPage />} />
          <Route path="verify/review" element={<VerifyReviewQueuePage />} />
          <Route path="verify/review/:id" element={<VerifyReviewApplicationPage />} />
          {SUMMIT_DEMO && FujiIntegrationPage && <Route path="fuji-integration" element={<FujiIntegrationPage />} />}
          <Route path="collection" element={<CollectionPage />} />
          <Route path="collectors" element={<CollectorsPage />} />
          <Route path="chronicle" element={<ChroniclePage />} />
          <Route path="the-call" element={<BleedPage />} />
          <Route path="the-bleed" element={<BleedPage />} />
          <Route path="choir" element={<ChoirPage />} />
          <Route path="reliquary" element={<ReliquaryPage />} />
          {VOID_LIVE && <Route path="covenant" element={<CovenantPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
