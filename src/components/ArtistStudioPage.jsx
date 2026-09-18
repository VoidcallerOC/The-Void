import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import {
  FUJI_RELEASE_CONFIG,
  FUJI_ROLES,
  assertFujiAddress,
  assertFujiGas,
  encodeCreateFujiEdition,
  fujiExplorerUrl,
  fujiSlug,
  fujiTokenId,
  readFujiPaused,
  readFujiRole,
  sendFujiTransaction,
  verifyFujiEditionCreation,
} from "../lib/fuji-release.js";
import { createArtist, createEdition, createExperience, createRelease, createToken, EXPERIENCE_TYPES } from "../domain/models.js";
import { notifyStudioOverlay, upsertStudioOverlay, useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { marketplaceCatalog } from "../lib/marketplace-surface.js";
import { ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const field = { width: "100%", boxSizing: "border-box", marginTop: 7, padding: "12px 12px", minHeight: 44, color: "var(--vc-bone)", background: "var(--vc-pit)", border: "1px solid var(--vc-ash)", fontFamily: "var(--font-body)", fontSize: 16 };
const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", marginTop: 16 };
const STEPS = [
  ["release", "Select release"],
  ["edition", "Edition details"],
  ["experience", "Experiences"],
  ["supply", "Supply"],
  ["metadata", "Metadata"],
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

function safeSlug(value) {
  try {
    return value ? fujiSlug(value) : "";
  } catch {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
  }
}

function initialState() {
  return {
    artistName: "",
    artistSlug: "",
    artistBio: "",
    releaseTitle: "",
    releaseSlug: "",
    releaseDescription: "",
    releaseArtwork: "/assets/voidcaller_art_5.png",
    editionName: "",
    editionSlug: "",
    editionDescription: "",
    editionArtwork: "/assets/voidcaller_art_4.png",
    includes: "Full self-titled EP\nCollector Reliquary access\nToken-gated music experiences",
    quantity: "25",
    metadataUri: "",
    priceWei: "10000000000000000",
    experienceTitle: "",
    experienceDescription: "",
    experienceType: "AUDIO",
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
  const [experienceId, setExperienceId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [txHash, setTxHash] = useState("");
  const [published, setPublished] = useState(false);
  const [onChainEdition, setOnChainEdition] = useState(null);
  const canUseStudio = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const set = (key, value) => setForm((prior) => ({ ...prior, [key]: value }));

  const releaseSlug = form.releaseSlug || safeSlug(form.releaseTitle);
  const editionSlug = form.editionSlug || safeSlug(form.editionName);
  const tokenPreview = releaseSlug && editionSlug ? fujiTokenId(releaseSlug, editionSlug).toString() : "";

  const persistOverlay = ({ status = "available", tokenId, transactionHash, artistKey, releaseKey, editionKey }) => {
    const nextArtistId = artistKey || artistId || safeSlug(form.artistSlug || form.artistName) || "studio-artist";
    const nextReleaseId = releaseKey || releaseId || releaseSlug;
    const nextEditionId = editionKey || editionId || editionSlug;
    const nextExperienceId = experienceId || (form.experienceTitle ? `${nextEditionId}-session` : "");
    const artist = createArtist({ id: nextArtistId, name: form.artistName || "Untitled artist", handle: form.artistSlug || nextArtistId, bio: form.artistBio, verified: true, avatar: form.releaseArtwork, banner: form.releaseArtwork });
    const release = createRelease({ id: nextReleaseId, artistId: artist.id, title: form.releaseTitle, subtitle: "Studio release", description: form.releaseDescription, artwork: form.releaseArtwork, status: "published", experiences: nextExperienceId ? [nextExperienceId] : [], tracks: [] });
    const includes = form.includes.split("\n").map((line) => line.trim()).filter(Boolean);
    const edition = createEdition({
      id: nextEditionId,
      releaseId: release.id,
      title: form.editionName,
      description: form.editionDescription,
      includes,
      tokenIds: tokenId ? [String(tokenId)] : [],
      contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
      chainId: FUJI_RELEASE_CONFIG.chainId,
      chain: FUJI_RELEASE_CONFIG.networkName,
      supply: form.quantity,
      status,
      metadataUri: form.metadataUri || `ipfs://the-void-${nextEditionId}`,
      experienceIds: nextExperienceId ? [nextExperienceId] : [],
      artwork: form.editionArtwork || form.releaseArtwork,
      tier: "standard",
    });
    const experience = form.experienceTitle
      ? createExperience({
        id: nextExperienceId,
        experienceType: EXPERIENCE_TYPES[form.experienceType] || EXPERIENCE_TYPES.AUDIO,
        title: form.experienceTitle,
        description: form.experienceDescription,
        editionId: edition.id,
        requirements: tokenId ? [{ type: "ownership", contract: FUJI_RELEASE_CONFIG.contractAddress, tokenIds: [String(tokenId)], minAmount: 1, chainId: FUJI_RELEASE_CONFIG.chainId }] : [],
        media: { type: "audio", protected: false, previewAvailable: true },
      })
      : null;
    upsertStudioOverlay({
      artists: [artist],
      releases: [release],
      editions: [edition],
      tokens: tokenId ? [createToken({ id: `${edition.id}-token`, editionId: edition.id, tokenId: String(tokenId), name: edition.title })] : [],
      experiences: experience ? [experience] : [],
    });
    notifyStudioOverlay();
    if (nextExperienceId) setExperienceId(nextExperienceId);
    return { artist, release, edition, experience, transactionHash };
  };

  const ensureArtistAndRelease = async () => {
    const nextArtistSlug = fujiSlug(form.artistSlug || form.artistName, "artist slug");
    const nextReleaseSlug = fujiSlug(form.releaseSlug || form.releaseTitle, "release slug");
    if (!form.artistName) throw new Error("Enter an artist name before creating a release.");
    if (!form.releaseTitle) throw new Error("Enter a release title before creating an edition.");
    let nextArtistId = artistId || nextArtistSlug;
    let nextReleaseId = releaseId || nextReleaseSlug;
    try {
      const artist = await studioFetch(artistId ? `/studio/artists/${encodeURIComponent(artistId)}` : "/studio/artists", {
        method: artistId ? "PATCH" : "POST",
        payload: { id: nextArtistId, name: form.artistName, slug: nextArtistSlug, bio: form.artistBio, profileArtwork: form.releaseArtwork, links: {} },
        headers,
      });
      nextArtistId = artist.id;
      setArtistId(artist.id);
      const release = await studioFetch(releaseId ? `/studio/releases/${encodeURIComponent(releaseId)}` : `/studio/artists/${encodeURIComponent(nextArtistId)}/releases`, {
        method: releaseId ? "PATCH" : "POST",
        payload: { id: nextReleaseId, title: form.releaseTitle, slug: nextReleaseSlug, description: form.releaseDescription, artwork: form.releaseArtwork, status: "PUBLISHED" },
        headers,
      });
      nextReleaseId = release.id;
      setReleaseId(release.id);
    } catch (error) {
      if (!String(error.message || "").includes("Artist Studio request failed") && !String(error.message || "").includes("unavailable")) throw error;
      nextArtistId = nextArtistSlug;
      nextReleaseId = nextReleaseSlug;
      setArtistId(nextArtistId);
      setReleaseId(nextReleaseId);
    }
    return { artistId: nextArtistId, releaseId: nextReleaseId, releaseSlug: nextReleaseSlug };
  };

  const saveDraft = async () => {
    setBusy("draft"); setNotice("");
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate an artist wallet first.");
      const ids = await ensureArtistAndRelease();
      const nextEditionSlug = fujiSlug(form.editionSlug || form.editionName, "edition slug");
      const tokenId = fujiTokenId(ids.releaseSlug, nextEditionSlug).toString();
      setEditionId(nextEditionSlug);
      try {
        const record = await studioFetch(editionId ? `/studio/editions/${encodeURIComponent(editionId)}` : `/studio/releases/${encodeURIComponent(ids.releaseId)}/editions`, {
          method: editionId ? "PATCH" : "POST",
          payload: {
            id: nextEditionSlug,
            name: form.editionName,
            description: form.editionDescription,
            artwork: form.editionArtwork,
            chainId: FUJI_RELEASE_CONFIG.chainId,
            contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
            tokenId,
            quantity: form.quantity,
            metadataUri: form.metadataUri || `ipfs://the-void-${nextEditionSlug}`,
            priceWei: form.priceWei,
            marketplace: {},
            metadata: { includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), artwork: form.editionArtwork },
          },
          headers,
        });
        setEditionId(record.id);
      } catch {
        setEditionId(nextEditionSlug);
      }
      persistOverlay({ status: "available", tokenId, artistKey: ids.artistId, releaseKey: ids.releaseId, editionKey: nextEditionSlug });
      setNotice(`Draft saved: ${form.editionName}.`);
      return nextEditionSlug;
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
      if (!wallet.account) throw new Error("Connect a wallet first.");
      if (!wallet.authenticated) await wallet.authenticate();
      const provider = wallet.getProvider();
      const nextReleaseSlug = fujiSlug(form.releaseSlug || form.releaseTitle, "release slug");
      const nextEditionSlug = fujiSlug(form.editionSlug || form.editionName, "edition slug");
      if (!form.editionName) throw new Error("Enter an edition name.");
      if (!form.quantity || BigInt(form.quantity) <= 0n) throw new Error("Edition supply must be greater than zero.");
      assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress);
      const paused = await readFujiPaused(provider);
      if (paused) throw new Error("The certified Fuji release is paused.");
      const hasArtistRole = await readFujiRole(provider, FUJI_ROLES.ARTIST_ROLE, wallet.account);
      if (!hasArtistRole) {
        throw new Error("This wallet does not have ARTIST_ROLE on VoidRelease1155. Create Edition is limited to authorized artist wallets. The transaction was not sent.");
      }
      const ids = await ensureArtistAndRelease();
      const metadataUri = form.metadataUri || `ipfs://the-void-${nextEditionSlug}`;
      const { tokenId, data } = encodeCreateFujiEdition({ releaseId: nextReleaseSlug, editionId: nextEditionSlug, maxSupply: form.quantity, metadataUri });
      await assertFujiGas(provider, { from: wallet.account, data });
      const result = await sendFujiTransaction({ provider, from: wallet.account, data });
      const verified = await verifyFujiEditionCreation(provider, { transactionHash: result.hash, releaseId: nextReleaseSlug, editionId: nextEditionSlug, tokenId });
      setTxHash(result.hash);
      setEditionId(nextEditionSlug);
      setReleaseId(ids.releaseId || nextReleaseSlug);
      setOnChainEdition({ tokenId: tokenId.toString(), blockNumber: verified.receipt.blockNumber ? Number.parseInt(verified.receipt.blockNumber, 16) : null, mintedSupply: verified.edition.mintedSupply.toString(), maxSupply: verified.edition.maxSupply.toString() });
      try {
        await studioFetch(`/studio/releases/${encodeURIComponent(ids.releaseId)}/editions`, {
          method: "POST",
          payload: {
            id: nextEditionSlug,
            name: form.editionName,
            description: form.editionDescription,
            artwork: form.editionArtwork,
            chainId: FUJI_RELEASE_CONFIG.chainId,
            contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
            tokenId: tokenId.toString(),
            quantity: form.quantity,
            metadataUri,
            priceWei: form.priceWei,
            marketplace: {},
            metadata: { includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), artwork: form.editionArtwork },
          },
          headers,
        });
        await studioFetch(`/studio/editions/${encodeURIComponent(nextEditionSlug)}`, {
          method: "PATCH",
          payload: { status: "PUBLISHED", metadata: { includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), artwork: form.editionArtwork, fuji: { contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: FUJI_RELEASE_CONFIG.chainId, tokenId: tokenId.toString(), transactionHash: result.hash, metadataUri } } },
          headers,
        });
      } catch {
        /* overlay still records the on-chain edition if studio persistence is down */
      }
      persistOverlay({ status: "available", tokenId: tokenId.toString(), transactionHash: result.hash, artistKey: ids.artistId, releaseKey: nextReleaseSlug, editionKey: nextEditionSlug });
      setPublished(true);
      setNotice(`Edition created on Fuji and verified on-chain. It is now available to collect.`);
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
    const nextReleaseSlug = safeSlug(record.release.id) || safeSlug(record.release.title);
    const nextArtistSlug = safeSlug(record.artist?.handle || record.artist?.id || record.artist?.name);
    setSelectedReleaseId(record.release.id);
    setArtistId(record.artist?.id || nextArtistSlug);
    setReleaseId(record.release.id);
    setForm((prior) => ({
      ...prior,
      artistName: record.artist?.name || prior.artistName,
      artistSlug: nextArtistSlug,
      artistBio: record.artist?.bio || prior.artistBio,
      releaseTitle: record.release.title,
      releaseSlug: nextReleaseSlug.slice(0, 31),
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
          Artist → Release → Edition → Experience → Collect. Create Edition publishes to the certified Fuji VoidRelease1155. It never reports success without a receipt.
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
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Edition details, experiences, supply, metadata, publish.</p>
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

      {notice && <div role="status" style={{ ...card, margin: "20px 0", borderColor: published || notice.includes("saved") ? "var(--vc-bone-dim)" : "var(--vc-crimson)" }}>{notice}</div>}

      {step === "release" && (
        <section style={card} id="create-edition">
          <Eyebrow red>Select release</Eyebrow>
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
          <TextField title="Artist slug" value={form.artistSlug} onChange={(value) => set("artistSlug", value)} placeholder="voidcaller" />
          <TextField title="Artist bio" value={form.artistBio} onChange={(value) => set("artistBio", value)} multiline />
          <TextField title="Release title" value={form.releaseTitle} onChange={(value) => set("releaseTitle", value)} required />
          <TextField title="Release slug (max 31)" value={form.releaseSlug} onChange={(value) => set("releaseSlug", value)} placeholder="the-repair" />
          <TextField title="Description" value={form.releaseDescription} onChange={(value) => set("releaseDescription", value)} multiline />
          <TextField title="Artwork URL" value={form.releaseArtwork} onChange={(value) => set("releaseArtwork", value)} />
          <button type="button" style={{ ...primaryBtn, marginTop: 22 }} onClick={() => setStep("edition")}>Continue to create edition</button>
        </section>
      )}

      {step === "edition" && (
        <section style={card}>
          <Eyebrow red>Create edition</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Edition details</h2>
          <p style={{ color: "var(--vc-bone-dim)" }}>Release: {form.releaseTitle || "Select a release first"}</p>
          <TextField title="Edition name" value={form.editionName} onChange={(value) => set("editionName", value)} required placeholder="Chapter I — The Repair" />
          <TextField title="Edition slug (max 31)" value={form.editionSlug} onChange={(value) => set("editionSlug", value)} placeholder="chapter-i-the-repair" />
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
          <TextField title="Experience title" value={form.experienceTitle} onChange={(value) => set("experienceTitle", value)} placeholder="Collector Reliquary" />
          <TextField title="Description" value={form.experienceDescription} onChange={(value) => set("experienceDescription", value)} multiline />
          <label style={label}>
            Type
            <select value={form.experienceType} onChange={(event) => set("experienceType", event.target.value)} style={field}>
              <option>AUDIO</option>
              <option>VIDEO</option>
              <option>DOWNLOAD</option>
              <option>STEMS</option>
            </select>
          </label>
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
          <p style={{ color: "var(--vc-bone-dim)" }}>Certified chain {FUJI_RELEASE_CONFIG.chainId} · VoidRelease1155. Token ID is derived after the slug is set.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("experience")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("metadata")}>Continue</button>
          </div>
        </section>
      )}

      {step === "metadata" && (
        <section style={card}>
          <Eyebrow red>Metadata</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>On-chain record</h2>
          <TextField title="Metadata URI" value={form.metadataUri} onChange={(value) => set("metadataUri", value)} placeholder="ipfs://the-void-chapter-i" />
          <TextField title="Certified chain ID" value={String(FUJI_RELEASE_CONFIG.chainId)} onChange={() => {}} readOnly />
          <TextField title="Certified contract" value={FUJI_RELEASE_CONFIG.contractAddress} onChange={() => {}} readOnly />
          <TextField title="Deterministic token ID" value={tokenPreview || "Calculated from release and edition slugs"} onChange={() => {}} readOnly />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("supply")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("publish")}>Review and publish</button>
          </div>
        </section>
      )}

      {step === "publish" && (
        <section style={card}>
          <Eyebrow red>Publish</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Create edition on Fuji</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
            {form.artistName || "Artist"} → {form.releaseTitle || "Release"} → {form.editionName || "Edition"}. Supply {form.quantity || "—"}.
            The wallet must hold ARTIST_ROLE. Success requires a confirmed receipt.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} disabled={busy !== "" || !canUseStudio} onClick={() => saveDraft().catch(() => {})}>
              {busy === "draft" ? "Saving…" : "Save draft"}
            </button>
            <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio} onClick={publishEdition}>
              {busy === "publish" ? "Confirming…" : "Create edition"}
            </button>
          </div>
          {published && (
            <div style={{ marginTop: 24, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div style={{ ...card, width: "100%", borderColor: "var(--vc-bone-dim)" }}>
                <Eyebrow red>Edition created · on-chain</Eyebrow>
                <p style={{ margin: "10px 0 0", color: "var(--vc-bone-dim)", lineHeight: 1.6 }}>Avalanche Fuji · chain {FUJI_RELEASE_CONFIG.chainId} · token {onChainEdition?.tokenId || tokenPreview}</p>
              </div>
              <Link to={`/edition/${editionId || editionSlug}`} style={primaryBtn}>View edition</Link>
              <Link to={`/release/${releaseId || releaseSlug}`} style={ghostBtn}>View release</Link>
              <Link to="/marketplace" style={ghostBtn}>Marketplace</Link>
            </div>
          )}
          {txHash && (
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", wordBreak: "break-all", marginTop: 16 }}>
              Receipt · <a href={fujiExplorerUrl("tx", txHash)} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{txHash}</a>
            </p>
          )}
        </section>
      )}
    </section>
  );
}
