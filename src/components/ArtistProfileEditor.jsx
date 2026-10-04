import { useEffect, useState } from "react";
import { Eyebrow } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { ARTWORK_ACCEPT, studioFetch, uploadStudioPortfolioImage } from "../lib/studio-api.js";
import { PROFILE_LINKS, portfolioImageSrc, profileFormFromRow, profilePayload, profileSocials } from "../lib/artist-profile.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";

const field = { width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,.04)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", padding: "12px 14px", fontSize: 15, marginTop: 6 };
const label = { display: "block", marginTop: 16, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)" };

const gateNote = { color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7 };

// Shown on an artist's public page only to an authenticated wallet that owns
// that artist (ownership comes from GET /studio/catalog, which the server
// scopes to the signed-in wallet). Saves through PATCH /studio/artists/:id.
// `standalone` (the /studio/profile/:id page) opens the form straight away and
// explains why it can't, instead of rendering nothing.
export function ArtistProfileEditor({ artistId, onSaved, standalone = false }) {
  const wallet = useWallet() || {};
  const [owned, setOwned] = useState({ artistId: null, row: null });
  const [open, setOpen] = useState(standalone);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const headers = wallet.authHeaders;
  const signedIn = wallet.connected && wallet.authenticated;

  useEffect(() => {
    let cancelled = false;
    if (!signedIn) return undefined;
    studioFetch("/studio/catalog", { headers })
      .then((catalog) => { if (!cancelled) setOwned({ artistId, row: (catalog?.artists || []).find((artist) => artist.id === artistId) || null }); })
      .catch(() => { if (!cancelled) setOwned({ artistId, row: null }); });
    return () => { cancelled = true; };
  }, [signedIn, headers, artistId]);

  // Only the signed-in owner of this exact artist ever sees the editor.
  const row = signedIn && owned.artistId === artistId ? owned.row : null;
  const setRow = (next) => setOwned({ artistId, row: next });
  if (!row) {
    if (!standalone) return null;
    if (!signedIn) return <p style={gateNote}>Connect and authenticate the wallet that owns this artist profile to edit it.</p>;
    if (owned.artistId !== artistId) return <p role="status" style={gateNote}>Loading your artist profile…</p>;
    return <p style={{ ...gateNote, color: "var(--vc-crimson)" }}>This artist profile is not owned by the connected wallet.</p>;
  }
  // The standalone page opens straight into the form once the row arrives.
  if (open && !form) setForm(profileFormFromRow(row));

  const set = (key, value) => setForm((prior) => ({ ...prior, [key]: value }));
  const setLink = (key, value) => setForm((prior) => ({ ...prior, links: { ...prior.links, [key]: value } }));
  const upload = async (key, file) => {
    setBusy(key); setNotice("");
    try {
      const uploaded = await uploadStudioPortfolioImage({ artistId, file, headers });
      set(key, uploaded.uri);
    } catch (error) { setNotice(error.message); } finally { setBusy(""); }
  };
  const save = async () => {
    setBusy("save"); setNotice("");
    try {
      const payload = profilePayload(form, row.profile_metadata);
      await studioFetch(`/studio/artists/${encodeURIComponent(artistId)}`, { method: "PATCH", payload, headers });
      const nextRow = { ...row, display_name: payload.name, bio: payload.bio, website_url: payload.websiteUrl, social_links: payload.links, profile_metadata: { ...payload.profileMetadata, profileArtwork: payload.profileArtwork } };
      setRow(nextRow);
      onSaved?.({ name: payload.name, bio: payload.bio, avatar: portfolioImageSrc(payload.profileArtwork || ""), banner: portfolioImageSrc(payload.profileMetadata.banner || ""), socials: profileSocials(payload.links, payload.websiteUrl) });
      if (standalone) setForm(profileFormFromRow(nextRow));
      else setOpen(false);
      setNotice("Profile saved.");
    } catch (error) { setNotice(error.message); } finally { setBusy(""); }
  };

  if (!open || !form) {
    return (
      <div style={{ margin: "20px 0 0", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" style={ghostBtn} onClick={() => { setForm(profileFormFromRow(row)); setOpen(true); setNotice(""); }}>Edit profile</button>
        {notice && <span role="status" style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{notice}</span>}
      </div>
    );
  }

  const imageField = (key, title) => (
    <div style={{ marginTop: 16 }}>
      <span style={label}>{title}</span>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        {form[key] && <img src={portfolioImageSrc(form[key])} alt={`${title} preview`} style={{ width: 96, aspectRatio: key === "banner" ? "3 / 1" : "1", objectFit: "cover", display: "block" }} />}
        <label style={{ ...ghostBtn, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy === key ? "Uploading…" : form[key] ? "Replace" : "Upload"}
          <input type="file" accept={ARTWORK_ACCEPT} disabled={Boolean(busy)} style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) upload(key, file); }} />
        </label>
        {form[key] && <button type="button" style={ghostBtn} disabled={Boolean(busy)} onClick={() => set(key, "")}>Remove</button>}
      </div>
    </div>
  );

  return (
    <section aria-label="Edit artist profile" style={{ border: "1px solid var(--vc-ash)", padding: 24, margin: "24px 0" }}>
      <Eyebrow red>Your artist profile</Eyebrow>
      <label style={label}>Artist name<input value={form.name} onChange={(event) => set("name", event.target.value)} style={field} required /></label>
      <label style={label}>Bio<textarea value={form.bio} onChange={(event) => set("bio", event.target.value)} rows={5} style={field} /></label>
      {imageField("avatar", "Profile picture")}
      {imageField("banner", "Banner")}
      <p style={{ ...gateNote, marginTop: 8 }}>Profile picture and banner are stored on the site, not uploaded to IPFS.</p>
      {PROFILE_LINKS.map(([key, title]) => (
        <label key={key} style={label}>{title}<input value={form.links[key]} onChange={(event) => setLink(key, event.target.value)} placeholder="https://" style={field} /></label>
      ))}
      {notice && <p role="status" style={{ color: notice === "Profile saved." ? "var(--vc-bone-dim)" : "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{notice}</p>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
        {!standalone && <button type="button" style={ghostBtn} disabled={Boolean(busy)} onClick={() => setOpen(false)}>Cancel</button>}
        <button type="button" style={primaryBtn} disabled={Boolean(busy)} onClick={save}>{busy === "save" ? "Saving…" : "Save profile"}</button>
      </div>
    </section>
  );
}
