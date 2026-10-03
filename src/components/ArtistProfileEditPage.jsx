import { Link, useParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { ArtistProfileEditor } from "./ArtistProfileEditor.jsx";
import { shell } from "../lib/marketplace-chrome.js";

// /studio/profile/:artistId — where Studio's "Edit artist profile" link goes.
// The editor itself enforces ownership: only the authenticated wallet that
// owns the artist (per GET /studio/catalog) gets the form.
export function ArtistProfileEditPage() {
  const { artistId = "" } = useParams();
  return (
    <section style={shell}>
      <Eyebrow red>† Artist Studio</Eyebrow>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(40px, 7vw, 72px)", margin: "12px 0 8px", textTransform: "uppercase" }}>Edit artist profile</h1>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 620, lineHeight: 1.7 }}>Name, bio, profile picture, banner and links shown on your public artist page.</p>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontFamily: "var(--font-mono)", fontSize: 11, margin: "10px 0 0" }}>
        <Link to="/studio" style={{ color: "var(--vc-bone-dim)" }}>← Back to Studio</Link>
        <Link to={`/artist/${encodeURIComponent(artistId)}`} style={{ color: "var(--vc-bone-dim)" }}>View public profile →</Link>
      </div>
      <div style={{ maxWidth: 720 }}>
        <ArtistProfileEditor artistId={artistId} standalone />
      </div>
    </section>
  );
}
