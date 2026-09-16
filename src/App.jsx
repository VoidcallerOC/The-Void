import { lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, useOutletContext } from "react-router-dom";
import { Layout } from "./components/Layout.jsx";
import { Hero } from "./components/Hero.jsx";
import { VOID_LIVE } from "./data.js";
import { DiscoverPage, ArtistsPage, ArtistPage, ReleasePage, EditionPage, ExperiencePage, CollectionPage, CollectorsPage } from "./components/PlatformPages.jsx";
import { ArtistStudioPage } from "./components/ArtistStudioPage.jsx";

// Hero is the above-the-fold landing — keep it eager. The rest of the
// sections are split into their own chunks and loaded on navigation.
const Chronicle = lazy(() => import("./components/Chronicle.jsx").then((m) => ({ default: m.Chronicle })));
const TheBleed = lazy(() => import("./components/TheBleed.jsx").then((m) => ({ default: m.TheBleed })));
const Choir = lazy(() => import("./components/Choir.jsx").then((m) => ({ default: m.Choir })));
const Covenant = lazy(() => import("./components/Covenant.jsx").then((m) => ({ default: m.Covenant })));
const Reliquary = lazy(() => import("./components/Reliquary.jsx").then((m) => ({ default: m.Reliquary })));

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
          <Route path="artists" element={<ArtistsPage />} />
          <Route path="artist/:artist" element={<ArtistPage />} />
          <Route path="release/:release" element={<ReleasePage />} />
          <Route path="edition/:edition" element={<EditionPage />} />
          <Route path="experience/:experience" element={<ExperiencePage />} />
          <Route path="studio" element={<ArtistStudioPage />} />
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
