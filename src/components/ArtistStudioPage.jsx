import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { EXPERIENCE_CATEGORIES, experienceCategory, experienceCategoryLabel } from "../domain/models.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { marketplaceCatalog } from "../lib/marketplace-surface.js";
import { ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { FUJI_ROLES, encodeCreateFujiEdition, readFujiRole, sendFujiTransaction, verifyFujiEditionCreation } from "../lib/fuji-release.js";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const field = { width: "100%", boxSizing: "border-box", marginTop: 7, padding: "12px 12px", minHeight: 44, color: "var(--vc-bone)", background: "var(--vc-pit)", border: "1px solid var(--vc-ash)", fontFamily: "var(--font-body)", fontSize: 16 };
const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", marginTop: 16 };
const STEPS = [
  ["release", "Your release"],
  ["edition", "Release details"],
  ["experience", "Experiences"],
  ["supply", "Supply"],
  ["preview", "Preview"],
  ["publish", "Publish"],
];

function TextField({ title, value, onChange, multiline = false, required = false, placeholder = "", readOnly = false }) {
  const Tag = multiline ? "textarea" : "input";
  return (
    <label style={label}>
      {title}
      <Tag required={required} readOnly={readOnly} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} rows={multiline ? 4 : undefined} style={{ ...field, opacity: readOnly ? 0.7 : 1 }} />
    </label>
  );
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

function initialState() {
  return {
    artistName: "",
    artistBio: "",
    releaseTitle: "",
    releaseDescription: "",
    releaseArtwork: "/assets/voidcaller_art_5.png",
    editionName: "",
    editionDescription: "",
    editionArtwork: "/assets/voidcaller_art_4.png",
    includes: "Full self-titled EP\nCollector Reliquary access\nToken-gated music experiences",
    quantity: "25",
    priceWei: "10000000000000000",
    experienceTitle: "",
    experienceDescription: "",
    productType: "FULL_RECORD",
  };
}

export function ArtistStudioPage() {
  const wallet = useWallet();
  const [params] = useSearchParams();
  const catalog = useMarketplaceCatalogs();
  const existingReleases = useMemo(() => marketplaceCatalog([catalog]), [catalog]);
  const createIntent = params.get("create") === "release" ? "release" : "edition";
  const [form, setForm] = useState(initialState);
  const [step, setStep] = useState("release");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [artistId, setArtistId] = useState("");
  const [releaseId, setReleaseId] = useState("");
  const [editionId, setEditionId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const canUseStudio = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const set = (key, value) => setForm((prior) => ({ ...prior, [key]: value }));


  const ensureArtistAndRelease = async () => {
    if (!form.artistName) throw new Error("Enter an artist name before creating a release.");
    if (!form.releaseTitle) throw new Error("Enter a release title before creating an edition.");
    let nextArtistId = artistId;
    let nextReleaseId = releaseId;
    const artist = await studioFetch(artistId ? `/studio/artists/${encodeURIComponent(artistId)}` : "/studio/artists", {
      method: artistId ? "PATCH" : "POST",
      payload: { id: nextArtistId || undefined, name: form.artistName, bio: form.artistBio, profileArtwork: form.releaseArtwork, links: {} },
      headers,
    });
    nextArtistId = artist.id;
    setArtistId(artist.id);
    const release = await studioFetch(releaseId ? `/studio/releases/${encodeURIComponent(releaseId)}` : `/studio/artists/${encodeURIComponent(nextArtistId)}/releases`, {
      method: releaseId ? "PATCH" : "POST",
      payload: { id: nextReleaseId || undefined, title: form.releaseTitle, description: form.releaseDescription, artwork: form.releaseArtwork },
      headers,
    });
    nextReleaseId = release.id;
    setReleaseId(release.id);
    return { artistId: nextArtistId, releaseId: nextReleaseId };
  };

  const createReleaseRecord = async () => {
    setBusy("release"); setNotice("");
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate an artist wallet first.");
      const ids = await ensureArtistAndRelease();
      setSelectedReleaseId(ids.releaseId);
      setNotice(`Release created: ${form.releaseTitle}. Continue to Create Edition when you are ready.`);
      setStep("edition");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  };

  const saveDraft = async () => {
    setBusy("draft"); setNotice("");
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate an artist wallet first.");
      const ids = await ensureArtistAndRelease();
      const record = await studioFetch(editionId ? `/studio/editions/${encodeURIComponent(editionId)}` : `/studio/releases/${encodeURIComponent(ids.releaseId)}/editions`, {
          method: editionId ? "PATCH" : "POST",
          payload: {
            id: editionId || undefined,
            name: form.editionName,
            description: form.editionDescription,
            artwork: form.editionArtwork,
            quantity: form.quantity,
            priceWei: form.priceWei,
            marketplace: {},
            metadata: { includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), artwork: form.editionArtwork },
          },
          headers,
        });
      setEditionId(record.id);
      setNotice(`Draft saved: ${form.editionName}.`);
      return record.id;
    } catch (error) {
      setNotice(error.message);
      throw error;
    } finally {
      setBusy("");
    }
  };

  const publishEdition = async () => {
    setBusy("publish"); setNotice("");
    try {
      if (!form.editionName) throw new Error("Enter an edition name.");
      if (!form.quantity || BigInt(form.quantity) <= 0n) throw new Error("Edition supply must be greater than zero.");
      if (!editionId) await saveDraft();
      const metadata = await studioFetch(`/studio/releases/${encodeURIComponent(releaseId)}/metadata`, {
        method: "POST",
        payload: { artwork: form.editionArtwork || form.releaseArtwork, includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), releaseType: "EP" },
        headers,
      });
      const provider = wallet.getProvider?.();
      if (!(await readFujiRole(provider, FUJI_ROLES.ARTIST_ROLE, wallet.account))) throw new Error("This authenticated artist wallet is not authorized to publish releases on Fuji.");
      const encoded = encodeCreateFujiEdition({ releaseId: metadata.releaseSlug, editionId: metadata.editionSlug, maxSupply: form.quantity, metadataUri: metadata.metadataUri });
      const transaction = await sendFujiTransaction({ provider, from: wallet.account, data: encoded.data });
      await verifyFujiEditionCreation(provider, { transactionHash: transaction.hash, releaseId: metadata.releaseSlug, editionId: metadata.editionSlug, tokenId: metadata.tokenId });
      await studioFetch(`/studio/releases/${encodeURIComponent(releaseId)}/publication/confirm`, { method: "POST", payload: { transactionHash: transaction.hash }, headers });
      setNotice(`Published ${form.releaseTitle}. Transaction confirmed: ${transaction.hash}`);
      setStep("publish");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  };

  const goCreateEdition = () => {
    if (!form.releaseTitle) setStep("release");
    else setStep("edition");
    setNotice(form.releaseTitle ? "" : "Select or create a release, then continue to Create Edition.");
  };

  const selectExistingRelease = (record) => {
    setSelectedReleaseId(record.release.id);
    setArtistId(record.artist?.id || "");
    setReleaseId(record.release.id);
    setForm((prior) => ({
      ...prior,
      artistName: record.artist?.name || prior.artistName,
      artistBio: record.artist?.bio || prior.artistBio,
      releaseTitle: record.release.title,
      releaseDescription: record.release.description || prior.releaseDescription,
      releaseArtwork: record.release.artwork || prior.releaseArtwork,
      editionArtwork: record.release.artwork || prior.editionArtwork,
    }));
    setStep("edition");
    setNotice(`Release selected: ${record.release.title}. Enter edition details.`);
  };

  return (
    <section style={shell}>
      <header style={{ marginBottom: 36, maxWidth: 760 }}>
        <Eyebrow red>† Artist studio</Eyebrow>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(52px, 9vw, 92px)", textTransform: "uppercase", lineHeight: 0.9, margin: "16px 0" }}>Create the relic</h1>
        <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7, margin: 0 }}>
          Artist → Release → Edition → Experience → Collect. The Void handles the infrastructure underneath and never reports success without a receipt.
        </p>
      </header>

      <div className="vc-studio-actions">
        <button type="button" className={`vc-studio-action${createIntent === "release" ? " is-primary" : ""}`} onClick={() => { setSelectedReleaseId(""); setStep("release"); }}>
          <Eyebrow>01</Eyebrow>
          <h2>Create release</h2>
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Name the artist and the record.</p>
        </button>
        <button type="button" className={`vc-studio-action${createIntent === "edition" ? " is-primary" : ""}`} onClick={goCreateEdition}>
          <Eyebrow red>02</Eyebrow>
          <h2>Create edition</h2>
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Edition details, experiences, supply, preview, publish.</p>
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 28 }}>
        <Link to="/marketplace" style={ghostBtn}>Marketplace</Link>
      </div>

      {!canUseStudio && (
        <div style={{ ...card, marginBottom: 24, borderColor: "var(--vc-crimson)", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong>Verified wallet required.</strong>
            <p style={{ margin: "8px 0 0", color: "var(--vc-bone-dim)" }}>Connect an authorized artist wallet and sign in before creating an edition.</p>
          </div>
          <WalletButton />
        </div>
      )}

      <nav aria-label="Studio workflow" className="vc-studio-steps">
        {STEPS.map(([id, title], index) => (
          <button key={id} type="button" onClick={() => setStep(id)} className={step === id ? "is-active" : ""}>
            <span>0{index + 1}</span> {title}
          </button>
        ))}
      </nav>

      {notice && <div role="status" style={{ ...card, margin: "20px 0", borderColor: notice.includes("saved") ? "var(--vc-bone-dim)" : "var(--vc-crimson)" }}>{notice}</div>}

      {step === "release" && (
        <section style={card} id="create-edition">
          <Eyebrow red>Your release</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>The record</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>Choose an existing release, or create a new one. Create Edition always publishes to the certified Fuji contract.</p>
          {existingReleases.length > 0 && (
            <div className="vc-release-picker">
              {existingReleases.map((record) => (
                <button
                  key={record.release.id}
                  type="button"
                  className={`vc-release-pick${selectedReleaseId === record.release.id ? " is-selected" : ""}`}
                  onClick={() => selectExistingRelease(record)}
                >
                  <img src={record.release.artwork} alt="" />
                  <div>
                    <p className="vc-card-kicker">{record.artist?.name}</p>
                    <strong style={{ display: "block", marginTop: 6 }}>{record.release.title}</strong>
                  </div>
                </button>
              ))}
            </div>
          )}
          <TextField title="Artist name" value={form.artistName} onChange={(value) => set("artistName", value)} required />
          <TextField title="Artist bio" value={form.artistBio} onChange={(value) => set("artistBio", value)} multiline />
          <TextField title="Release title" value={form.releaseTitle} onChange={(value) => set("releaseTitle", value)} required />
          <TextField title="Description" value={form.releaseDescription} onChange={(value) => set("releaseDescription", value)} multiline />
          <TextField title="Artwork URL" value={form.releaseArtwork} onChange={(value) => set("releaseArtwork", value)} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio} onClick={createReleaseRecord}>
              {busy === "release" ? "Creating…" : "Create release"}
            </button>
            {releaseId && <button type="button" style={ghostBtn} onClick={() => setStep("edition")}>Create edition</button>}
          </div>
        </section>
      )}

      {step === "edition" && (
        <section style={card}>
          <Eyebrow red>Create edition</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Edition details</h2>
          <p style={{ color: "var(--vc-bone-dim)" }}>Release: {form.releaseTitle || "Select a release first"}</p>
          <TextField title="Edition name" value={form.editionName} onChange={(value) => set("editionName", value)} required placeholder="Chapter I — The Repair" />
          <TextField title="Description" value={form.editionDescription} onChange={(value) => set("editionDescription", value)} multiline />
          <TextField title="Artwork URL" value={form.editionArtwork} onChange={(value) => set("editionArtwork", value)} />
          <TextField title="Collector receives (one per line)" value={form.includes} onChange={(value) => set("includes", value)} multiline />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("release")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("experience")}>Continue</button>
          </div>
        </section>
      )}

      {step === "experience" && (
        <section style={card}>
          <Eyebrow red>Experiences</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>What it unlocks</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>Choose the music-native promise first. The protected delivery mechanism is handled underneath by the existing experience service.</p>
          <label style={label}>
            What does this edition unlock?
            <select value={form.productType} onChange={(event) => set("productType", event.target.value)} style={field}>
              {Object.entries(EXPERIENCE_CATEGORIES).map(([value, category]) => <option key={value} value={value} disabled={!category.supported}>{category.label}{category.supported ? "" : " — coming soon"}</option>)}
            </select>
          </label>
          <TextField title="Experience name" value={form.experienceTitle} onChange={(value) => set("experienceTitle", value)} placeholder={experienceCategoryLabel(form.productType)} />
          <TextField title="Description" value={form.experienceDescription} onChange={(value) => set("experienceDescription", value)} multiline />
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--vc-bone-dim)" }}>
            Delivery · {experienceCategory(form.productType)?.deliveryType || "Not configured"}
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("edition")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("supply")}>Continue</button>
          </div>
        </section>
      )}

      {step === "supply" && (
        <section style={card}>
          <Eyebrow red>Supply</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>How many relics</h2>
          <TextField title="Quantity" value={form.quantity} onChange={(value) => set("quantity", value)} required />
          <TextField title="Price (wei)" value={form.priceWei} onChange={(value) => set("priceWei", value)} />
          <p style={{ color: "var(--vc-bone-dim)" }}>Set the number of collectors this release is made for.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("experience")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("preview")}>Continue</button>
          </div>
        </section>
      )}

      {step === "preview" && (
        <section style={card}>
          <Eyebrow red>Review</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>{form.releaseTitle || "Untitled release"}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 240px) 1fr", gap: 24, alignItems: "start", marginTop: 20 }}>
            <img src={form.releaseArtwork} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover" }} />
            <div>
              <p><strong>Artist</strong><br />{form.artistName || "—"}</p>
              <p><strong>Release</strong><br />{form.releaseTitle || "—"}</p>
              <p><strong>Type</strong><br />EP</p>
              <p><strong>Collector receives</strong><br />{form.includes.split("\n").filter(Boolean).join(" · ") || "—"}</p>
              <p><strong>Experiences</strong><br />{form.experienceTitle || experienceCategoryLabel(form.productType)}</p>
              <p><strong>Supply</strong><br />{form.quantity || "—"}</p>
            </div>
          </div>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7, marginTop: 24 }}>Publishing creates the on-chain collectible for this release. No blockchain knowledge required.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("supply")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("publish")}>Publish release</button>
          </div>
        </section>
      )}

      {step === "publish" && (
        <section style={card}>
          <Eyebrow red>Publish</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Publish release</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
            Publishing creates your collectible release on The Void. Supply {form.quantity || "—"}.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} disabled={busy !== "" || !canUseStudio} onClick={() => saveDraft().catch(() => {})}>
              {busy === "draft" ? "Saving…" : "Save draft"}
            </button>
            <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio} onClick={publishEdition}>
              {busy === "publish" ? "Publishing…" : "Publish release"}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
