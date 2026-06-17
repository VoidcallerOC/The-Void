import { lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, useOutletContext } from "react-router-dom";
import { Layout } from "./components/Layout.jsx";
import { Hero } from "./components/Hero.jsx";
import { VOID_LIVE } from "./data.js";

// Hero is the above-the-fold landing — keep it eager. The rest of the
// sections are split into their own chunks and loaded on navigation.
const Chronicle = lazy(() => import("./components/Chronicle.jsx").then((m) => ({ default: m.Chronicle })));
const TheBleed = lazy(() => import("./components/TheBleed.jsx").then((m) => ({ default: m.TheBleed })));
const Choir = lazy(() => import("./components/Choir.jsx").then((m) => ({ default: m.Choir })));
const Covenant = lazy(() => import("./components/Covenant.jsx").then((m) => ({ default: m.Covenant })));
const Reliquary = lazy(() => import("./components/Reliquary.jsx").then((m) => ({ default: m.Reliquary })));
const Bridge = lazy(() => import("./components/Bridge.jsx").then((m) => ({ default: m.Bridge })));

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
function BridgePage() {
  return <Bridge />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="chronicle" element={<ChroniclePage />} />
          <Route path="the-bleed" element={<BleedPage />} />
          <Route path="choir" element={<ChoirPage />} />
          <Route path="reliquary" element={<ReliquaryPage />} />
          <Route path="bridge" element={<BridgePage />} />
          {VOID_LIVE && <Route path="covenant" element={<CovenantPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
