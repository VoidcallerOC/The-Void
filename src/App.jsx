import { BrowserRouter, Routes, Route, Navigate, useOutletContext } from "react-router-dom";
import { Layout } from "./components/Layout.jsx";
import { Hero } from "./components/Hero.jsx";
import { Chronicle } from "./components/Chronicle.jsx";
import { TheBleed } from "./components/TheBleed.jsx";
import { Choir } from "./components/Choir.jsx";
import { Covenant } from "./components/Covenant.jsx";
import { Reliquary } from "./components/Reliquary.jsx";
import { VOID_LIVE } from "./data.js";

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
