import { useMemo, useState } from "react";
import { useWallet } from "../lib/wallet-context.js";

const shell = { maxWidth: 1100, margin: "0 auto", padding: "clamp(120px, 16vw, 180px) clamp(20px, 5vw, 48px)" };
const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const field = { width: "100%", boxSizing: "border-box", marginTop: 7, padding: "10px 12px", color: "var(--vc-bone)", background: "var(--vc-pit)", border: "1px solid var(--vc-ash)", fontFamily: "var(--font-body)" };
const button = { border: "1px solid var(--vc-crimson)", color: "var(--vc-bone)", background: "var(--vc-crimson)", padding: "11px 16px", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", cursor: "pointer" };
const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", marginTop: 14 };

function initialForms() {
  return {
    artist: { id: "", name: "", slug: "", bio: "", profileArtwork: "", links: "{}" },
    release: { id: "", title: "", slug: "", description: "", artwork: "", status: "DRAFT" },
    edition: { id: "", name: "", description: "", artwork: "", chainId: "43113", contractAddress: "", tokenId: "", quantity: "", priceWei: "", marketplace: "{}", status: "DRAFT" },
    experience: { id: "", title: "", description: "", type: "AUDIO", requirements: '[{"type":"erc1155-balance","contract":"0x","tokenIds":["0"],"minAmount":"1"}]', mediaConfig: '{"protected":false}', status: "DRAFT" },
  };
}

function TextField({ title, value, onChange, multiline = false, required = false, placeholder = "" }) {
  const Tag = multiline ? "textarea" : "input";
  return <label style={label}>{title}<Tag required={required} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} rows={multiline ? 4 : undefined} style={field} /></label>;
}

function Lifecycle({ value, onChange }) {
  return <label style={label}>Lifecycle<select value={value} onChange={(event) => onChange(event.target.value)} style={field}><option>DRAFT</option><option>REVIEW</option><option>PUBLISHED</option></select></label>;
}

function apiBase() {
  return import.meta.env.VITE_API_ORIGIN ? import.meta.env.VITE_API_ORIGIN.replace(/\/$/, "") : "";
}

async function studioFetch(path, { method, payload, headers }) {
  const response = await fetch(`${apiBase()}/api${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Artist Studio request failed (${response.status}).`);
  return body.data;
}

function StudioCard({ eyebrow, title, children }) {
  return <section style={card}><p style={{ fontFamily: "var(--font-mono)", color: "var(--vc-crimson)", fontSize: 10, letterSpacing: ".16em", margin: "0 0 10px" }}>{eyebrow}</p><h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 34, lineHeight: 1, margin: "0 0 12px" }}>{title}</h2>{children}</section>;
}

/** Minimal studio surface. It deliberately promotes release and edition names,
 * with contract/token values confined to the edition configuration form. */
export function ArtistStudioPage() {
  const wallet = useWallet();
  const [forms, setForms] = useState(initialForms);
  const [artistId, setArtistId] = useState("");
  const [releaseId, setReleaseId] = useState("");
  const [editionId, setEditionId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const canUseStudio = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const update = (section, key, value) => setForms((prior) => ({ ...prior, [section]: { ...prior[section], [key]: value } }));
  const report = (message) => setNotice(message);

  const submitArtist = async (event) => {
    event.preventDefault(); setBusy("artist"); setNotice("");
    try {
      const existingId = artistId || forms.artist.id;
      const payload = { ...forms.artist, links: JSON.parse(forms.artist.links) };
      const record = await studioFetch(existingId ? `/studio/artists/${encodeURIComponent(existingId)}` : "/studio/artists", { method: existingId ? "PATCH" : "POST", payload, headers });
      setArtistId(record.id); update("artist", "id", record.id); report(`Artist saved: ${record.display_name || record.id}.`);
    } catch (error) { report(error instanceof SyntaxError ? "Artist links must be valid JSON." : error.message); } finally { setBusy(""); }
  };
  const submitRelease = async (event) => {
    event.preventDefault(); setBusy("release"); setNotice("");
    try {
      if (!artistId) throw new Error("Save an artist before creating a release.");
      const existingId = releaseId || forms.release.id;
      const record = await studioFetch(existingId ? `/studio/releases/${encodeURIComponent(existingId)}` : `/studio/artists/${encodeURIComponent(artistId)}/releases`, { method: existingId ? "PATCH" : "POST", payload: forms.release, headers });
      setReleaseId(record.id); update("release", "id", record.id); report(`Release saved: ${record.title || record.id}.`);
    } catch (error) { report(error.message); } finally { setBusy(""); }
  };
  const submitEdition = async (event) => {
    event.preventDefault(); setBusy("edition"); setNotice("");
    try {
      if (!releaseId) throw new Error("Save a release before creating an edition.");
      const existingId = editionId || forms.edition.id;
      const payload = { ...forms.edition, marketplace: JSON.parse(forms.edition.marketplace) };
      const record = await studioFetch(existingId ? `/studio/editions/${encodeURIComponent(existingId)}` : `/studio/releases/${encodeURIComponent(releaseId)}/editions`, { method: existingId ? "PATCH" : "POST", payload, headers });
      setEditionId(record.id); update("edition", "id", record.id); report(`Edition saved: ${record.title || record.id}.`);
    } catch (error) { report(error instanceof SyntaxError ? "Marketplace configuration must be valid JSON." : error.message); } finally { setBusy(""); }
  };
  const submitExperience = async (event) => {
    event.preventDefault(); setBusy("experience"); setNotice("");
    try {
      if (!editionId) throw new Error("Save an edition before creating an experience.");
      const payload = { ...forms.experience, requirements: JSON.parse(forms.experience.requirements), mediaConfig: JSON.parse(forms.experience.mediaConfig) };
      const existingId = forms.experience.id;
      const record = await studioFetch(existingId ? `/studio/experiences/${encodeURIComponent(existingId)}` : `/studio/editions/${encodeURIComponent(editionId)}/experiences`, { method: existingId ? "PATCH" : "POST", payload, headers });
      update("experience", "id", record.id); report(`Experience saved: ${record.title || record.id}.`);
    } catch (error) { report(error instanceof SyntaxError ? "Requirements and media configuration must be valid JSON." : error.message); } finally { setBusy(""); }
  };

  return <section style={shell}>
    <header style={{ maxWidth: 740, marginBottom: 42 }}><p style={{ fontFamily: "var(--font-mono)", color: "var(--vc-crimson)", fontSize: 11, letterSpacing: ".18em" }}>† ARTIST STUDIO · PRIVATE</p><h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(50px, 9vw, 90px)", textTransform: "uppercase", lineHeight: .9, margin: "18px 0" }}>Make a record<br />a relic</h1><p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>Create and manage the music-native catalog as a sequence: artist, release, edition, then experience. Publishing is a lifecycle action; wallet authentication is required for every write.</p></header>
    {!canUseStudio && <div style={{ ...card, marginBottom: 24, borderColor: "var(--vc-crimson)" }}><strong>Verified wallet authentication required.</strong><p style={{ marginBottom: 0, color: "var(--vc-bone-dim)" }}>Connect an authorized artist wallet in the site header, then sign the authentication message before using the Studio.</p></div>}
    {notice && <div role="status" style={{ ...card, marginBottom: 24, borderColor: notice.includes("saved:") ? "var(--vc-bone-dim)" : "var(--vc-crimson)", color: "var(--vc-bone)" }}>{notice}</div>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, opacity: canUseStudio ? 1 : .5, pointerEvents: canUseStudio ? "auto" : "none" }}>
      <StudioCard eyebrow="01 · ARTIST" title="Identity"><form onSubmit={submitArtist}><TextField title="Artist name" value={forms.artist.name} onChange={(value) => update("artist", "name", value)} required /><TextField title="Slug" value={forms.artist.slug} onChange={(value) => update("artist", "slug", value)} required placeholder="lowercase-name" /><TextField title="Bio" value={forms.artist.bio} onChange={(value) => update("artist", "bio", value)} multiline /><TextField title="Profile artwork URL" value={forms.artist.profileArtwork} onChange={(value) => update("artist", "profileArtwork", value)} /><TextField title="Links (JSON)" value={forms.artist.links} onChange={(value) => update("artist", "links", value)} multiline /><button disabled={busy === "artist"} style={{ ...button, marginTop: 18 }}>{busy === "artist" ? "Saving…" : artistId ? "Save artist" : "Create artist"}</button></form></StudioCard>
      <StudioCard eyebrow="02 · RELEASE" title="Record"><form onSubmit={submitRelease}><TextField title="Release title" value={forms.release.title} onChange={(value) => update("release", "title", value)} required /><TextField title="Slug" value={forms.release.slug} onChange={(value) => update("release", "slug", value)} required /><TextField title="Description" value={forms.release.description} onChange={(value) => update("release", "description", value)} multiline /><TextField title="Artwork URL" value={forms.release.artwork} onChange={(value) => update("release", "artwork", value)} /><Lifecycle value={forms.release.status} onChange={(value) => update("release", "status", value)} /><button disabled={busy === "release"} style={{ ...button, marginTop: 18 }}>{busy === "release" ? "Saving…" : releaseId ? "Save release" : "Create release"}</button></form></StudioCard>
      <StudioCard eyebrow="03 · EDITION" title="Relic"><form onSubmit={submitEdition}><TextField title="Edition name" value={forms.edition.name} onChange={(value) => update("edition", "name", value)} required /><TextField title="Description" value={forms.edition.description} onChange={(value) => update("edition", "description", value)} multiline /><TextField title="Artwork URL" value={forms.edition.artwork} onChange={(value) => update("edition", "artwork", value)} /><TextField title="Chain ID" value={forms.edition.chainId} onChange={(value) => update("edition", "chainId", value)} required /><TextField title="ERC-1155 contract" value={forms.edition.contractAddress} onChange={(value) => update("edition", "contractAddress", value)} required /><TextField title="Token ID" value={forms.edition.tokenId} onChange={(value) => update("edition", "tokenId", value)} required /><TextField title="Quantity" value={forms.edition.quantity} onChange={(value) => update("edition", "quantity", value)} required /><TextField title="Price (wei)" value={forms.edition.priceWei} onChange={(value) => update("edition", "priceWei", value)} required /><TextField title="Marketplace configuration (JSON)" value={forms.edition.marketplace} onChange={(value) => update("edition", "marketplace", value)} multiline /><Lifecycle value={forms.edition.status} onChange={(value) => update("edition", "status", value)} /><button disabled={busy === "edition"} style={{ ...button, marginTop: 18 }}>{busy === "edition" ? "Saving…" : editionId ? "Save edition" : "Create edition"}</button></form></StudioCard>
      <StudioCard eyebrow="04 · EXPERIENCE" title="Access"><form onSubmit={submitExperience}><TextField title="Experience title" value={forms.experience.title} onChange={(value) => update("experience", "title", value)} required /><TextField title="Description" value={forms.experience.description} onChange={(value) => update("experience", "description", value)} multiline /><label style={label}>Media type<select value={forms.experience.type} onChange={(event) => update("experience", "type", event.target.value)} style={field}><option>AUDIO</option><option>VIDEO</option><option>DOWNLOAD</option><option>STEMS</option></select></label><TextField title="Ownership requirements (JSON)" value={forms.experience.requirements} onChange={(value) => update("experience", "requirements", value)} multiline required /><TextField title="Media configuration (JSON)" value={forms.experience.mediaConfig} onChange={(value) => update("experience", "mediaConfig", value)} multiline required /><Lifecycle value={forms.experience.status} onChange={(value) => update("experience", "status", value)} /><button disabled={busy === "experience"} style={{ ...button, marginTop: 18 }}>{busy === "experience" ? "Saving…" : forms.experience.id ? "Save experience" : "Create experience"}</button></form></StudioCard>
    </div>
  </section>;
}
