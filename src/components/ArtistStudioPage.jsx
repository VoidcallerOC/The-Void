import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { EXPERIENCE_CATEGORIES, experienceCategory, experienceCategoryLabel } from "../domain/models.js";
import { mapPublishedCatalog } from "../lib/catalog-source.js";
import { ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { FUJI_RELEASE_CONFIG, FUJI_ROLES, assertFujiAddress, encodeCreateFujiEdition, encodeFujiMint, fujiExplorerUrl, readFujiEdition, readFujiRole, sendFujiTransaction, simulateCreateFujiEdition, simulateFujiCall, verifyFujiEditionCreation } from "../lib/fuji-release.js";
import { createFujiPublicProvider, encodeConfigureSale, explainConfigureSaleError, formatAvax, fujiPrimarySaleAddress, fujiReleaseIsV2, readPrimarySale, simulateConfigureSale, validateSaleSupply } from "../lib/primary-sale.js";
import { publicationResultMessage, studioPublicationPath, transactionEvidenceForOutcome, validateReleasePublish } from "../lib/studio-publish.js";
import { editionHasGatedTrack, resumeOwnedRelease, selectReleaseTemplate } from "../lib/studio-selection.js";
import { tracksOnRelease } from "../lib/studio-tracks.js";
import { studioArtistChoices, studioReleaseChoices } from "../lib/studio-release-choices.js";
import { ARCHIVE_ACCEPT, ARTWORK_ACCEPT, AUDIO_ACCEPT, MAX_FULL_TRACK_BYTES, VIDEO_ACCEPT, formatMegabytes, studioFetch, uploadStudioArtwork, uploadStudioFullTrack, uploadStudioPreview } from "../lib/studio-api.js";
import { ipfsToHttp } from "../lib/web3.js";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const field = { width: "100%", boxSizing: "border-box", marginTop: 7, padding: "12px 12px", minHeight: 44, color: "var(--vc-bone)", background: "var(--vc-pit)", border: "1px solid var(--vc-ash)", fontFamily: "var(--font-body)", fontSize: 16 };
const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", marginTop: 16 };
const STEPS = [
  ["release", "Your release"],
  ["track", "Tracks"],
  ["experience", "Experiences"],
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

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1000))} KB`;
}

// Per-upload feedback shown right under its button, so a result is never lost
// in the page-level notice: uploading, a confirmed result, or the error.
export function UploadStatus({ status, signedIn = true }) {
  if (!signedIn) return <p role="status" style={{ margin: "8px 0 0", color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Sign in with your artist wallet to upload.</p>;
  if (!status) return null;
  const color = status.state === "error" ? "var(--vc-crimson)" : status.state === "done" ? "#7bd88f" : "var(--vc-bone-dim)";
  const prefix = status.state === "done" ? "✓ " : status.state === "error" ? "✕ " : "";
  return <p role="status" aria-live="polite" style={{ margin: "8px 0 0", color, fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all" }}>{prefix}{status.message}</p>;
}

// Artwork is either uploaded here (pinned publicly, stored as ipfs://) or an
// existing image URL pasted into the field.
function ArtworkField({ title, value, onChange, onUpload, uploading, disabled, status, signedIn }) {
  const preview = ipfsToHttp(value);
  return (
    <div style={{ marginTop: 16 }}>
      <TextField title={title} value={value} onChange={onChange} placeholder="Upload an image or paste an image URL" />
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <label style={{ ...ghostBtn, cursor: disabled || uploading ? "not-allowed" : "pointer", opacity: disabled || uploading ? 0.6 : 1 }}>
          {uploading ? "Uploading…" : "Upload artwork"}
          <input type="file" accept={ARTWORK_ACCEPT} disabled={disabled || uploading} style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onUpload(file); }} />
        </label>
        <span style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>PNG, JPEG, GIF or WebP · 3 MB max</span>
      </div>
      <UploadStatus status={status} signedIn={signedIn} />
      {preview && <img src={preview} alt={`${title} preview`} style={{ width: 160, aspectRatio: "1", objectFit: "cover", marginTop: 12, display: "block" }} />}
    </div>
  );
}

function isUnlimitedQuantity(value) {
  const text = String(value ?? "").trim();
  return text === "" || /^0+$/.test(text);
}

function supplyLabel(value) {
  return isUnlimitedQuantity(value) ? "Unlimited until the sale ends" : String(value);
}

function initialState() {
  return {
    artistName: "",
    releaseTitle: "",
    releaseDescription: "",
    releaseArtwork: "",
    trackTitle: "",
    trackDescription: "",
    trackArtwork: "",
    trackPreview: "",
    includes: "Full self-titled EP\nCollector Reliquary access\nToken-gated music experiences",
    quantity: "25",
    priceWei: "10000000000000000",
    royaltyBps: "500",
    saleSupply: "",
    perWalletLimit: "1",
    saleStart: "",
    saleEnd: "",
    salePaused: false,
    experienceTitle: "",
    experienceDescription: "",
    productType: "FULL_RECORD",
  };
}

// Stable key for a track in the mint picker.
const mintTrackKey = (track) => String(track.tokenId ?? track.id ?? track.title);

export function ArtistStudioPage() {
  const wallet = useWallet();
  const [params] = useSearchParams();
  const [ownedStudioCatalog, setOwnedStudioCatalog] = useState(null);
  const createIntent = params.get("create") === "track" ? "track" : "release";
  const [workflow, setWorkflow] = useState(createIntent === "track" ? "mint" : "catalog");
  const [form, setForm] = useState(initialState);
  const [step, setStep] = useState("release");
  const requestedReleaseId = params.get("release");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [artistId, setArtistId] = useState("");
  const [releaseId, setReleaseId] = useState("");
  const [editionId, setEditionId] = useState("");
  const [publishedTokenId, setPublishedTokenId] = useState("");
  const [configuredSale, setConfiguredSale] = useState(null);
  const [notice, setNotice] = useState("");
  // On a failed Fuji transaction, hold the hash + explorer link so the user can
  // recover and inspect the exact transaction instead of losing it.
  const [txEvidence, setTxEvidence] = useState(null);
  const [busy, setBusy] = useState("");
  const [fullTrack, setFullTrack] = useState(null);
  // Private audio that collectors unlock through the experience (e.g. a demo).
  // Falls back to the full track when the artist doesn't add a separate file.
  const [experienceAudio, setExperienceAudio] = useState(null);
  // Edition whose catalog structure was saved with a private full track this session.
  const [gatedEditionId, setGatedEditionId] = useState("");
  // Outcome of "Save catalog structure", shown beside the button (the page notice is far above it).
  const [catalogStatus, setCatalogStatus] = useState(null);
  const [uploads, setUploads] = useState({});
  const [mintReleaseId, setMintReleaseId] = useState("");
  const [mintTrackIds, setMintTrackIds] = useState([]);
  const [mintEditionId, setMintEditionId] = useState("");
  const [mintAmount, setMintAmount] = useState("1");
  const [mintTxHashes, setMintTxHashes] = useState([]);
  // Mint outcome shown beside the Mint button (the page-level notice sits far above it).
  const [mintStatus, setMintStatus] = useState(null);
  const canUseStudio = wallet.connected && wallet.authenticated;
  const editionGated = Boolean(editionId) && (gatedEditionId === editionId || editionHasGatedTrack(ownedStudioCatalog, editionId));
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const set = (key, value) => setForm((prior) => ({ ...prior, [key]: value }));
  const existingReleases = useMemo(() => studioReleaseChoices(ownedStudioCatalog || {}), [ownedStudioCatalog]);
  const ownedArtists = useMemo(() => studioArtistChoices(ownedStudioCatalog?.artists || []), [ownedStudioCatalog]);
  const activeArtist = ownedArtists.find((artist) => artist.id === artistId) || ownedArtists[0] || null;
  const selectedMintRelease = ownedStudioCatalog?.releases?.find((release) => release.id === mintReleaseId) || null;
  const mintEditions = (ownedStudioCatalog?.editions || []).filter((edition) => edition.releaseId === mintReleaseId);
  // Only editions on the certified Fuji contract can be minted from Studio; when
  // there is exactly one, use it without making the artist pick it.
  const mintableEditions = mintEditions.filter((edition) => String(edition.contractAddress || "").toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase());
  const selectedMintEdition = mintEditions.find((edition) => edition.id === mintEditionId) || (mintableEditions.length === 1 ? mintableEditions[0] : null);
  const mintTracks = useMemo(() => tracksOnRelease(selectedMintRelease, mintEditions), [selectedMintRelease, mintEditions]);

  const openPublishedSale = (catalog, requestedReleaseId) => {
    const resumed = resumeOwnedRelease(catalog, requestedReleaseId);
    if (!resumed?.published || !resumed.tokenId) return false;
    setSelectedReleaseId(resumed.releaseId);
    setArtistId(resumed.artistId || catalog.releases?.find((release) => release.id === resumed.releaseId)?.artistId || "");
    setReleaseId(resumed.releaseId);
    setEditionId(resumed.editionId || "");
    setPublishedTokenId(resumed.tokenId);
    setForm((prior) => ({ ...prior, ...Object.fromEntries(Object.entries(resumed.form || {}).filter(([, value]) => value !== undefined)) }));
    setConfiguredSale(null);
    setWorkflow("catalog");
    setStep("sale");
    setNotice(`${resumed.title} is loaded from the published catalog. Check the on-chain primary sale state below.`);
    return true;
  };

  useEffect(() => {
    let cancelled = false;
    if (!canUseStudio) return undefined;
    studioFetch("/studio/catalog", { headers })
      .then((payload) => {
        if (cancelled) return;
        const catalog = mapPublishedCatalog(payload);
        setOwnedStudioCatalog(catalog);
        if (requestedReleaseId) openPublishedSale(catalog, requestedReleaseId);
      })
      .catch((error) => { if (!cancelled) setNotice(error.message); });
    return () => { cancelled = true; };
  }, [canUseStudio, headers, requestedReleaseId]);

  useEffect(() => {
    let cancelled = false;
    if (!canUseStudio || step !== "sale" || !publishedTokenId || !fujiPrimarySaleAddress()) return undefined;
    const publicProvider = createFujiPublicProvider();
    readPrimarySale(publicProvider, publishedTokenId, wallet.account)
      .then((sale) => { if (!cancelled) setConfiguredSale(sale); })
      .catch(() => { if (!cancelled) setConfiguredSale(null); });
    return () => { cancelled = true; };
  }, [canUseStudio, publishedTokenId, step, wallet, wallet.account]);




  // Releases are published as the wallet's own artist profile. Profile details
  // (name, bio, pictures, links) are edited on the artist page, never here, so
  // Studio no longer overwrites them. Only a wallet with no profile yet creates one.
  const ensureArtist = async () => {
    if (artistId) return artistId;
    if (activeArtist) { setArtistId(activeArtist.id); return activeArtist.id; }
    if (!form.artistName.trim()) throw new Error("Enter your artist name to create your artist profile.");
    const artist = await studioFetch("/studio/artists", { method: "POST", payload: { name: form.artistName.trim(), links: {} }, headers });
    setArtistId(artist.id);
    setOwnedStudioCatalog((prior) => ({ ...(prior || {}), artists: [...(prior?.artists || []), { id: artist.id, name: artist.display_name || form.artistName.trim(), handle: artist.slug || artist.id }] }));
    return artist.id;
  };

  const ensureArtistAndRelease = async () => {
    if (!form.releaseTitle) throw new Error("Enter a release title before creating a track.");
    const nextArtistId = await ensureArtist();
    let nextReleaseId = releaseId;
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
      setNotice(`Release created: ${form.releaseTitle}. Continue to Tracks when you are ready.`);
      setStep("track");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  };

  const saveDraft = async (knownIds = null) => {
    setBusy("draft"); setNotice("");
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate an artist wallet first.");
      const ids = knownIds || await ensureArtistAndRelease();
      const record = await studioFetch(editionId ? `/studio/editions/${encodeURIComponent(editionId)}` : `/studio/releases/${encodeURIComponent(ids.releaseId)}/editions`, {
          method: editionId ? "PATCH" : "POST",
          payload: {
            id: editionId || undefined,
            title: form.trackTitle || form.releaseTitle,
            description: form.trackDescription,
            artwork: form.trackArtwork,
            quantity: form.quantity,
            priceWei: form.priceWei,
            marketplace: {},
            metadata: { includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), artwork: form.trackArtwork, ...(form.trackPreview ? { previewAudio: form.trackPreview } : {}) },
          },
          headers,
        });
      setEditionId(record.id);
      setNotice(`Track draft saved: ${form.trackTitle || form.releaseTitle}.`);
      return { releaseId: ids.releaseId, editionId: record.id };
    } catch (error) {
      setNotice(error.message);
      throw error;
    } finally {
      setBusy("");
    }
  };

  const saveCatalogStructure = async () => {
    setBusy("catalog"); setNotice(""); setCatalogStatus({ ok: true, message: "Saving catalog structure…" });
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate an artist wallet first.");
      const alreadyGated = Boolean(editionId) && (gatedEditionId === editionId || editionHasGatedTrack(ownedStudioCatalog, editionId));
      // Holders unlock the private full track through this experience, so never
      // save it without one (that would publish a token that unlocks nothing).
      const unlockAudio = experienceAudio || fullTrack;
      if (!unlockAudio && !alreadyGated) throw new Error("Upload the experience audio below (or the full track on the Tracks step). It is what holders unlock.");
      const ids = editionId ? { releaseId, editionId } : await saveDraft();
      if (!ids.editionId) throw new Error("Save the track draft before configuring its experience.");
      if (!unlockAudio && alreadyGated) {
        const done = "Catalog already saved with its private full track. Continue to Supply.";
        setNotice(done); setCatalogStatus({ ok: true, message: done }); setStep("supply");
        return;
      }
      await studioFetch(`/studio/editions/${encodeURIComponent(ids.editionId)}/experiences`, {
        method: "POST",
        payload: {
          title: form.experienceTitle || experienceCategoryLabel(form.productType),
          description: form.experienceDescription,
          experienceType: experienceCategory(form.productType)?.deliveryType || "AUDIO",
          productType: form.productType,
          requirements: [],
          mediaConfig: { protected: true, protectedMedia: [{ assetId: unlockAudio.assetId, mediaType: unlockAudio.mediaType || "AUDIO", contentType: unlockAudio.contentType }] },
        },
        headers,
      });
      setGatedEditionId(ids.editionId);
      const done = `Catalog saved: holders of ${form.releaseTitle || "this release"} unlock ${unlockAudio.filename || unlockAudio.assetId}. Continue with supply and publishing.`;
      setNotice(done);
      setCatalogStatus({ ok: true, message: done });
      setStep("supply");
    } catch (error) {
      setNotice(error.message);
      setCatalogStatus({ ok: false, message: error.message || "The catalog could not be saved." });
    } finally { setBusy(""); }
  };

  const publishEdition = async () => {
    setBusy("publish"); setNotice(""); setTxEvidence(null);
    try {
      // Token metadata is fixed once the edition exists on Fuji, so the public
      // preview and the gated full track must be in place before publishing.
      if (!form.trackPreview) throw new Error("Upload the public preview clip on the Tracks step before publishing. A token's metadata cannot be changed after it is published.");
      if (!editionId || (gatedEditionId !== editionId && !editionHasGatedTrack(ownedStudioCatalog, editionId))) throw new Error("Save the catalog structure with the private full track before publishing, so holders can unlock it.");
      validateReleasePublish({
        release: { title: form.releaseTitle, type: "ep" },
        tracks: [{ title: form.trackTitle || form.releaseTitle }],
        supply: form.quantity,
        metadata: { artwork: form.trackArtwork || form.releaseArtwork, includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean) },
      });
      const ids = await ensureArtistAndRelease();
      const saved = editionId ? { releaseId: ids.releaseId, editionId } : await saveDraft(ids);
      const metadata = await studioFetch(studioPublicationPath(saved.releaseId, "metadata"), {
        method: "POST",
        payload: { artwork: form.trackArtwork || form.releaseArtwork, ...(form.trackPreview ? { previewAudio: form.trackPreview } : {}), includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), releaseType: "EP" },
        headers,
      });
      const provider = wallet.getProvider?.();
      if (!(await readFujiRole(provider, FUJI_ROLES.ARTIST_ROLE, wallet.account))) throw new Error("This wallet does not have ARTIST_ROLE on the Fuji contract yet. The contract admin grants it at /admin/roles.");
      const encoded = fujiReleaseIsV2()
        ? encodeCreateFujiEdition({ releaseId: metadata.releaseSlug, editionId: metadata.editionSlug, maxSupply: form.quantity, metadataUri: metadata.metadataUri, payout: wallet.account, royaltyBps: form.royaltyBps || 0 })
        : encodeCreateFujiEdition({ releaseId: metadata.releaseSlug, editionId: metadata.editionSlug, maxSupply: form.quantity, metadataUri: metadata.metadataUri });
      // Simulate the exact createEdition call from this wallet first, so a revert
      // (edition already exists, contract paused, role revoked) surfaces its real
      // reason before a transaction is ever broadcast.
      await simulateCreateFujiEdition(provider, { from: wallet.account, data: encoded.data });
      const transaction = await sendFujiTransaction({ provider, from: wallet.account, data: encoded.data });
      await verifyFujiEditionCreation(provider, { transactionHash: transaction.hash, releaseId: metadata.releaseSlug, editionId: metadata.editionSlug, tokenId: metadata.tokenId });
      const confirmed = await studioFetch(studioPublicationPath(saved.releaseId, "publication/confirm"), { method: "POST", payload: { transactionHash: transaction.hash }, headers });
      const result = publicationResultMessage({ title: form.releaseTitle, provenanceStatus: confirmed.provenanceStatus, fullyPublished: confirmed.fullyPublished === true });
      setNotice(result.message);
      if (!result.fullyPublished) return;
      setPublishedTokenId(encoded.tokenId.toString());
      setStep("sale");
    } catch (error) {
      setNotice(error.message);
      setTxEvidence(transactionEvidenceForOutcome({ status: "failure", error, fallbackExplorerUrl: error?.transactionHash ? fujiExplorerUrl("tx", error.transactionHash) : null }));
    } finally {
      setBusy("");
    }
  };

  const configureSale = async () => {
    setBusy("sale"); setTxEvidence(null);
    setNotice("");
    try {
      const sale = fujiPrimarySaleAddress();
      if (!sale) throw new Error("VoidPrimarySale is not deployed on Fuji yet. The collectible stays ERC-1155, but fans cannot pay until the sale contract is configured.");
      if (!publishedTokenId) throw new Error("Publish the release before setting up the sale.");
      if (!canUseStudio) throw new Error("Connect and authenticate an artist wallet first.");
      if (wallet.chainId !== FUJI_RELEASE_CONFIG.chainId) throw Object.assign(new Error(`Switch your wallet to ${FUJI_RELEASE_CONFIG.network} (chain ${FUJI_RELEASE_CONFIG.chainId}) before configuring the sale.`), { code: "CHAIN_MISMATCH" });
      // All reads and the exact preflight use the public Fuji RPC. The wallet
      // provider is intentionally acquired only after preflight succeeds, for
      // the user-confirmed transaction submission below.
      const publicProvider = createFujiPublicProvider();
      const edition = await readFujiEdition(publicProvider, publishedTokenId);
      if (!edition?.exists) throw new Error("The published edition could not be found on Fuji. Refresh the edition before configuring its sale.");
      const existingSale = await readPrimarySale(publicProvider, publishedTokenId, wallet.account);
      if (existingSale?.configured) {
        setConfiguredSale(existingSale);
        setNotice("This release already has a primary sale configured. No transaction was submitted.");
        return;
      }
      const openEdition = BigInt(edition.maxSupply) === 0n;
      const rawSaleSupply = String(form.saleSupply ?? "").trim();
      const requestedSaleSupply = rawSaleSupply === "" ? (openEdition ? "0" : (form.quantity || edition.maxSupply)) : rawSaleSupply;
      const saleSupply = validateSaleSupply(requestedSaleSupply, edition.maxSupply);
      if (openEdition && !String(form.saleEnd ?? "").trim()) {
        throw new Error("An unlimited edition must have a sale end time. That end time closes the edition.");
      }
      const perWalletLimit = String(form.perWalletLimit ?? "").trim() === "" && openEdition ? "0" : form.perWalletLimit;
      const data = encodeConfigureSale({
        tokenId: publishedTokenId,
        priceWei: form.priceWei,
        maxSupply: saleSupply,
        perWalletLimit,
        startTime: form.saleStart,
        endTime: form.saleEnd,
        paused: form.salePaused,
        openEdition,
      });
      await simulateConfigureSale(publicProvider, { from: wallet.account, data });
      const walletProvider = wallet.getProvider?.();
      if (!walletProvider?.request) throw Object.assign(new Error("The wallet provider is unavailable. Reconnect your wallet before configuring the sale."), { code: "WALLET_PROVIDER_UNAVAILABLE" });
      let transaction;
      try {
        transaction = await sendFujiTransaction({ provider: walletProvider, receiptProvider: publicProvider, from: wallet.account, data, to: sale, assumeFujiChain: true });
      } catch (error) {
        throw Object.assign(new Error(explainConfigureSaleError({ ...error, code: error?.code === "ACTION_REJECTED" || error?.code === 4001 ? error.code : "TRANSACTION_SUBMISSION_FAILED" }).message), { code: error?.code === "ACTION_REJECTED" || error?.code === 4001 ? "TRANSACTION_REJECTED" : "TRANSACTION_SUBMISSION_FAILED", cause: error, transactionHash: error?.transactionHash });
      }
      setNotice(`Sale configured at ${formatAvax(form.priceWei)}. Transaction confirmed: ${transaction.hash}`);
      setConfiguredSale(await readPrimarySale(publicProvider, publishedTokenId, wallet.account));
    } catch (error) {
      setNotice(explainConfigureSaleError(error).message);
      setTxEvidence(transactionEvidenceForOutcome({ status: "failure", error, fallbackExplorerUrl: error?.transactionHash ? fujiExplorerUrl("tx", error.transactionHash) : null }));
    } finally {
      setBusy("");
    }
  };

  const startNewTrack = () => {
    if (!selectedMintRelease) return;
    setSelectedReleaseId(selectedMintRelease.id);
    setArtistId(selectedMintRelease.artistId || "");
    setReleaseId(selectedMintRelease.id);
    setEditionId("");
    setGatedEditionId("");
    setPublishedTokenId("");
    setFullTrack(null);
    setExperienceAudio(null);
    setForm((prior) => ({
      ...prior,
      releaseTitle: selectedMintRelease.title || prior.releaseTitle,
      releaseDescription: selectedMintRelease.description || "",
      releaseArtwork: selectedMintRelease.artwork || "",
      trackTitle: "",
      trackDescription: "",
      trackArtwork: "",
      trackPreview: "",
      experienceTitle: "",
      experienceDescription: "",
    }));
    setWorkflow("catalog");
    setStep("track");
    setNotice(`${selectedMintRelease.title} stays the release. Name the new song below. Saving adds that track to this release. It does not mint more copies of a song already on it.`);
  };

  const mintSelectedTracks = async () => {
    setBusy("mint-tracks"); setNotice(""); setMintTxHashes([]); setTxEvidence(null); setMintStatus({ ok: true, message: "Checking mint permission on Fuji…" });
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate the artist wallet before minting.");
      if (!selectedMintRelease) throw new Error("Select an existing album or collection first.");
      if (!selectedMintEdition) throw new Error(mintableEditions.length ? "Select the target contract for this catalog." : "This catalog has no edition on the certified Fuji contract, so there is nothing Studio can mint for it yet.");
      if (!mintTrackIds.length) throw new Error("Select at least one existing track.");
      const target = assertFujiAddress(selectedMintEdition.contractAddress);
      const provider = wallet.getProvider?.();
      if (!(await readFujiRole(provider, FUJI_ROLES.ISSUER_ROLE, wallet.account))) throw new Error("This wallet does not have ISSUER_ROLE on the Fuji contract yet. The contract admin grants it at /admin/roles.");
      // Same key the checkboxes use, so every ticked track is actually minted.
      const selected = mintTracks.filter((track) => mintTrackIds.includes(mintTrackKey(track)));
      if (!selected.length) throw new Error("None of the selected tracks could be matched. Re-select the tracks and try again.");
      const hashes = [];
      for (const track of selected) {
        if (track.tokenId === undefined || track.tokenId === null || track.tokenId === "") throw new Error(`Track ${track.title || "(untitled)"} has no token relationship yet.`);
        setMintStatus({ ok: true, message: `Confirm the mint for ${track.title || "the track"} in your wallet…` });
        const data = encodeFujiMint({ to: wallet.account, tokenId: track.tokenId, amount: mintAmount });
        await simulateFujiCall(provider, { from: wallet.account, to: target, data });
        const transaction = await sendFujiTransaction({ provider, from: wallet.account, to: target, data });
        hashes.push({ title: track.title, hash: transaction.hash });
      }
      setMintTxHashes(hashes);
      const done = `${hashes.length} token mint${hashes.length === 1 ? "" : "s"} confirmed on Fuji for ${selectedMintRelease.title}.`;
      setNotice(done);
      setMintStatus({ ok: true, message: done });
    } catch (error) {
      setNotice(error.message);
      setMintStatus({ ok: false, message: error.message || "The mint failed." });
      setTxEvidence(transactionEvidenceForOutcome({ status: "failure", error, fallbackExplorerUrl: error?.transactionHash ? fujiExplorerUrl("tx", error.transactionHash) : null }));
    } finally { setBusy(""); }
  };

  // Runs one upload and records its outcome next to its own button.
  const runUpload = async (key, file, upload, describe) => {
    setBusy(key); setNotice("");
    setUploads((prior) => ({ ...prior, [key]: { state: "uploading", message: `Uploading ${file.name} (${formatBytes(file.size)})…` } }));
    try {
      if (!canUseStudio) throw new Error("Sign in with your artist wallet to upload.");
      const result = await upload(artistId || await ensureArtist());
      setUploads((prior) => ({ ...prior, [key]: { state: "done", message: describe(result) } }));
    } catch (error) {
      const phase = error.phase === "upload" ? "Upload failed" : error.phase === "private-storage" ? "Private storage not available" : error.phase === "registration" ? "Registration failed" : "Upload failed";
      setUploads((prior) => ({ ...prior, [key]: { state: "error", message: `${file.name}: ${phase}: ${error.message}` } }));
    } finally { setBusy(""); }
  };

  const uploadArtwork = (key, file) => runUpload(`artwork:${key}`, file, async (owner) => {
    const uploaded = await uploadStudioArtwork({ artistId: owner, file, headers });
    set(key, uploaded.uri);
    return uploaded;
  }, (uploaded) => `Uploaded ${file.name} (${formatBytes(uploaded.byteSize ?? file.size)}) · ${uploaded.uri}`);

  const uploadPreview = (file) => runUpload("preview", file, async (owner) => {
    const uploaded = await uploadStudioPreview({ artistId: owner, file, headers });
    set("trackPreview", uploaded.uri);
    return uploaded;
  }, (uploaded) => `Public preview uploaded: ${file.name} (${formatBytes(uploaded.byteSize ?? file.size)}) · ${uploaded.uri}`);

  // Private, token-gated audio: same verified pipeline for the full track and
  // for experience audio (private storage, artist ownership, SHA-256).
  const uploadPrivateAudio = (key, file, onUploaded, describe, mediaType = "AUDIO") => runUpload(key, file, async (owner) => {
    const progress = (event) => {
      const message = event.stage === "hashing" ? `Checking ${file.name} (${formatBytes(file.size)})…`
        : event.stage === "uploading" ? `Uploading ${file.name} privately… ${Math.floor((event.loaded / event.total) * 100)}% of ${formatBytes(event.total)}`
        : event.stage === "registering" ? `Registering ${file.name}…`
        : `Verifying ${file.name} in private storage…`;
      setUploads((prior) => ({ ...prior, [key]: { state: "uploading", message } }));
    };
    const uploaded = await uploadStudioFullTrack({ artistId: owner, file, headers, mediaType, onProgress: progress });
    onUploaded(uploaded);
    return uploaded;
  }, describe);
  const uploadFullTrack = (file) => uploadPrivateAudio("full-track", file, setFullTrack, (uploaded) => `Full track stored privately: ${file.name} (${formatBytes(uploaded.byteSize ?? file.size)}) · asset ${uploaded.assetId}.`);
  const uploadExperienceAudio = (file) => {
    const mediaType = experienceCategory(form.productType)?.deliveryType || "AUDIO";
    const noun = mediaType === "VIDEO" ? "video" : mediaType === "STEMS" || mediaType === "DOWNLOAD" ? "file" : "audio";
    return uploadPrivateAudio("experience-audio", file, setExperienceAudio, (uploaded) => `Experience ${noun} stored privately: ${file.name} (${formatBytes(uploaded.byteSize ?? file.size)}) · asset ${uploaded.assetId}. Save the catalog structure to unlock it for holders.`, mediaType);
  };

  const selectExistingRelease = (record) => {
    if (record.release.status === "published" && openPublishedSale(ownedStudioCatalog, record.release.id)) return;
    const selection = selectReleaseTemplate(record);
    setSelectedReleaseId(selection.selectedReleaseId);
    setArtistId(selection.artistId);
    setReleaseId(selection.releaseId);
    setEditionId(selection.editionId);
    setForm((prior) => ({ ...prior, ...selection.form }));
    setStep("track");
    setNotice(`Release template loaded: ${selection.form.releaseTitle}. Create it under the authenticated artist wallet before publishing.`);
  };

  return (
    <section style={shell}>
      <header style={{ marginBottom: 36, maxWidth: 760 }}>
        <Eyebrow red>† Artist studio</Eyebrow>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(52px, 9vw, 92px)", textTransform: "uppercase", lineHeight: 0.9, margin: "16px 0" }}>Create the relic</h1>
        <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7, margin: 0 }}>
          Artist → Release → Track → Experience → Collect. The Void handles the infrastructure underneath and never reports success without a receipt.
        </p>
      </header>

      <div className="vc-studio-actions">
        <button type="button" className={`vc-studio-action${workflow === "catalog" ? " is-primary" : ""}`} onClick={() => { setWorkflow("catalog"); setSelectedReleaseId(""); setStep("release"); }}>
          <Eyebrow>01</Eyebrow>
          <h2>Create release</h2>
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Build and edit your musical catalog.</p>
        </button>
        <button type="button" className={`vc-studio-action${workflow === "mint" ? " is-primary" : ""}`} onClick={() => { setWorkflow("mint"); setStep("mint"); setNotice(""); }}>
          <Eyebrow red>02</Eyebrow>
          <h2>Add tracks</h2>
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Add another song to a release, or mint copies of a track already on-chain.</p>
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 28 }}>
        <Link to="/marketplace" style={ghostBtn}>Marketplace</Link>
      </div>

      {!canUseStudio && (
        <div style={{ ...card, marginBottom: 24, borderColor: "var(--vc-crimson)", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong>Verified wallet required.</strong>
            <p style={{ margin: "8px 0 0", color: "var(--vc-bone-dim)" }}>Connect an authorized artist wallet and sign in before creating a release.</p>
            {wallet.authenticationError && <p role="alert" style={{ margin: "8px 0 0", color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{wallet.authenticationError}</p>}
          </div>
          <WalletButton />
        </div>
      )}


      {workflow === "catalog" && <nav aria-label="Catalog editor workflow" className="vc-studio-steps">
        {STEPS.map(([id, title], index) => (
          <button key={id} type="button" onClick={() => setStep(id)} className={step === id ? "is-active" : ""}>
            <span>0{index + 1}</span> {title}
          </button>
        ))}
      </nav>}

      {notice && <div role="status" style={{ ...card, margin: "20px 0", borderColor: /saved|published|configured|confirmed|uploaded/i.test(notice) ? "var(--vc-bone-dim)" : "var(--vc-crimson)" }}>{notice}</div>}
      {txEvidence && (
        <div role="status" style={{ ...card, margin: "20px 0", borderColor: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" }}>
          <div>Failed transaction {txEvidence.code ? `(${txEvidence.code})` : ""} — inspect the exact revert on Snowtrace:</div>
          <a href={txEvidence.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{txEvidence.transactionHash}</a>
          <div style={{ marginTop: 6 }}>Contract {txEvidence.contractAddress} · chain {txEvidence.chainId}</div>
        </div>
      )}

      {workflow === "mint" && step === "mint" && (
        <section style={card} aria-label="Mint existing tracks">
          <Eyebrow red>Token minting / deployment</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Add tracks</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>Pick the release. Add track puts a new song on that same release. Mint quantity is how many copies of a track that is already on-chain.</p>
          {!canUseStudio ? <p style={{ color: "var(--vc-crimson)" }}>Connect and authenticate the artist wallet to load your catalog.</p> : ownedStudioCatalog && !existingReleases.length ? <p style={{ color: "var(--vc-bone-dim)" }}>No albums or collections are available for this authenticated artist.</p> : null}
          <label style={label}>
            Select album / collection
            <select value={mintReleaseId} onChange={(event) => { setMintReleaseId(event.target.value); setMintEditionId(""); setMintTrackIds([]); setMintStatus(null); setNotice(""); }} style={field} disabled={!existingReleases.length}>
              <option value="">Choose an existing catalog record</option>
              {existingReleases.map(({ release, artist }) => <option key={release.id} value={release.id}>{artist?.name ? `${artist.name} — ` : ""}{release.title}</option>)}
            </select>
          </label>
          {selectedMintRelease && <>
            <label style={label}>Tracks on this release</label>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {mintTracks.length ? mintTracks.map((track) => {
                const id = mintTrackKey(track);
                const onChain = track.tokenId !== undefined && track.tokenId !== null && track.tokenId !== "";
                return <label key={id} style={{ ...label, marginTop: 0, display: "flex", gap: 10, alignItems: "center", textTransform: "none", letterSpacing: 0, fontSize: 14 }}><input type="checkbox" disabled={!onChain} checked={mintTrackIds.includes(id)} onChange={() => setMintTrackIds((prior) => prior.includes(id) ? prior.filter((item) => item !== id) : [...prior, id])} /> {track.title || "Untitled track"}{onChain ? ` · token ${track.tokenId}` : " · not on-chain yet"}</label>;
              }) : (
                <div>
                  <p style={{ color: "var(--vc-bone-dim)", margin: "0 0 12px" }}>Nothing to mint yet: this release has not been published on Fuji, so it has no token. Publishing creates the on-chain edition; its token then appears here.</p>
                  <button type="button" style={ghostBtn} disabled={busy !== ""} onClick={() => {
                    const resumed = resumeOwnedRelease(ownedStudioCatalog, mintReleaseId);
                    if (!resumed) { setMintStatus({ ok: false, message: "This release could not be loaded into the editor." }); return; }
                    if (resumed.published) { setMintStatus({ ok: false, message: `${resumed.title} is already published on Fuji and its token metadata cannot change. To publish it again with a preview and full track, create a new release in the catalog editor.` }); return; }
                    setSelectedReleaseId(resumed.releaseId);
                    setArtistId(resumed.artistId);
                    setReleaseId(resumed.releaseId);
                    setEditionId(resumed.editionId);
                    setForm((prior) => ({ ...prior, ...resumed.form }));
                    setWorkflow("catalog");
                    setStep("track");
                    setNotice(`${resumed.form.releaseTitle} is loaded. Check its preview clip and full track${resumed.gated ? "" : ", save the catalog structure"}, then publish it on Fuji.`);
                  }}>Publish this release on Fuji →</button>
                </div>
              )}
            </div>
            <label style={label}>
              Select target contract
              <select value={selectedMintEdition?.id || ""} onChange={(event) => setMintEditionId(event.target.value)} style={field}>
                <option value="">Choose a contract</option>
                {mintEditions.map((edition) => <option key={edition.id} value={edition.id} disabled={String(edition.contractAddress || "").toLowerCase() !== FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()}>{edition.contractAddress || "Contract not configured"} · chain {edition.chainId || "—"}</option>)}
              </select>
            </label>
            {selectedMintEdition && String(selectedMintEdition.contractAddress || "").toLowerCase() !== FUJI_RELEASE_CONFIG.contractAddress.toLowerCase() && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>This contract is not the certified Fuji mint target and is read-only in Artist Studio.</p>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
              <button type="button" style={primaryBtn} onClick={startNewTrack}>Add track</button>
            </div>
            <TextField title="Mint quantity per selected track" value={mintAmount} onChange={setMintAmount} required />
            <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>This number is copies of the tracks you checked. It does not add a new song.</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
              <button type="button" style={ghostBtn} disabled={busy !== ""} onClick={mintSelectedTracks}>{busy === "mint-tracks" ? "Minting…" : "Mint copies"}</button>
              <button type="button" style={ghostBtn} onClick={() => { setWorkflow("catalog"); setStep("release"); }}>Back to catalog editor</button>
            </div>
            {mintStatus && <p role="status" style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 12, color: mintStatus.ok ? "var(--vc-bone-dim)" : "var(--vc-crimson)" }}>{mintStatus.ok ? "" : "✕ "}{mintStatus.message}</p>}
            {mintTxHashes.length > 0 && <div style={{ marginTop: 20, fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all" }}><strong>On-chain result</strong>{mintTxHashes.map((tx) => <div key={tx.hash}>{tx.title}: <a href={fujiExplorerUrl("tx", tx.hash)} target="_blank" rel="noreferrer">{tx.hash}</a></div>)}</div>}
          </>
          }
        </section>
      )}

      {workflow === "catalog" && step === "release" && (
        <section style={card} id="create-release">
          <Eyebrow red>Your release</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>The record</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>Choose an existing release, or create a new one. Publishing uses the certified Fuji contract underneath.</p>
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
          {activeArtist ? (
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", margin: "8px 0 4px" }}>
              {ownedArtists.length > 1 ? (
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--vc-bone-dim)" }}>
                  Publishing as{" "}
                  <select value={activeArtist.id} onChange={(event) => setArtistId(event.target.value)} style={{ background: "transparent", color: "var(--vc-bone)", border: "1px solid var(--vc-ash)", padding: "6px 8px" }}>
                    {ownedArtists.map((artist) => <option key={artist.id} value={artist.id}>{ownedArtists.filter((other) => other.name === artist.name).length > 1 ? `${artist.name} (${artist.handle || artist.id})` : artist.name}</option>)}
                  </select>
                </label>
              ) : (
                <p style={{ margin: 0 }}>Publishing as <strong>{activeArtist.name}</strong></p>
              )}
              <Link to={`/studio/profile/${encodeURIComponent(activeArtist.id)}`} style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Edit artist profile →</Link>
            </div>
          ) : (
            canUseStudio && ownedStudioCatalog && <TextField title="Your artist name (creates your artist profile — add bio and links on your profile page)" value={form.artistName} onChange={(value) => set("artistName", value)} required />
          )}
          <TextField title="Release title" value={form.releaseTitle} onChange={(value) => set("releaseTitle", value)} required />
          <TextField title="Description" value={form.releaseDescription} onChange={(value) => set("releaseDescription", value)} multiline />
          <ArtworkField title="Release artwork" value={form.releaseArtwork} onChange={(value) => set("releaseArtwork", value)} onUpload={(file) => uploadArtwork("releaseArtwork", file)} uploading={busy === "artwork:releaseArtwork"} disabled={busy !== "" || !canUseStudio} status={uploads["artwork:releaseArtwork"]} signedIn={canUseStudio} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio} onClick={createReleaseRecord}>
              {busy === "release" ? "Creating…" : "Create release"}
            </button>
            {releaseId && <button type="button" style={ghostBtn} onClick={() => setStep("track")}>Add tracks</button>}
          </div>
        </section>
      )}

      {workflow === "catalog" && step === "track" && (
        <section style={card}>
          <Eyebrow red>Tracks</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Track details</h2>
          <p style={{ color: "var(--vc-bone-dim)" }}>Release: {form.releaseTitle || "Select a release first"}. {editionId ? "Editing this track." : releaseId ? "Saving adds a new track on this release. It does not change the songs already on it." : ""}</p>
          <TextField title="Track title" value={form.trackTitle} onChange={(value) => set("trackTitle", value)} placeholder="Defaults to the release title" />
          <TextField title="Description" value={form.trackDescription} onChange={(value) => set("trackDescription", value)} multiline />
          <ArtworkField title="Track artwork (optional — uses the release artwork if empty)" value={form.trackArtwork} onChange={(value) => set("trackArtwork", value)} onUpload={(file) => uploadArtwork("trackArtwork", file)} uploading={busy === "artwork:trackArtwork"} disabled={busy !== "" || !canUseStudio} status={uploads["artwork:trackArtwork"]} signedIn={canUseStudio} />
          <div style={{ marginTop: 16 }}>
            <p style={{ margin: "0 0 8px" }}>Public preview (~30 seconds) — played by wallets and marketplaces from the token metadata</p>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...ghostBtn, cursor: busy !== "" || !canUseStudio ? "not-allowed" : "pointer", opacity: busy !== "" || !canUseStudio ? 0.6 : 1 }}>
                {busy === "preview" ? "Uploading…" : form.trackPreview ? "Replace preview" : "Upload preview"}
                <input type="file" accept={AUDIO_ACCEPT} disabled={busy !== "" || !canUseStudio} style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) uploadPreview(file); }} />
              </label>
              <span style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>~30 s clip · 5 MB max · public</span>
            </div>
            <UploadStatus status={uploads.preview} signedIn={canUseStudio} />
            {form.trackPreview && <audio controls preload="none" src={ipfsToHttp(form.trackPreview)} style={{ width: "100%", marginTop: 12 }} />}
          </div>
          <div style={{ marginTop: 16 }}>
            <p style={{ margin: "0 0 8px" }}>Full track (private master) — never public; holders unlock it unless you add separate experience audio on the Experiences step</p>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...ghostBtn, cursor: busy !== "" || !canUseStudio ? "not-allowed" : "pointer", opacity: busy !== "" || !canUseStudio ? 0.6 : 1 }}>
                {busy === "full-track" ? "Uploading…" : fullTrack ? "Replace full track" : "Upload full track"}
                <input type="file" accept={AUDIO_ACCEPT} disabled={busy !== "" || !canUseStudio} style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) uploadFullTrack(file); }} />
              </label>
              <span style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{`WAV, AIFF, FLAC or MP3 · ${formatMegabytes(MAX_FULL_TRACK_BYTES)} max · private · token-gated`}</span>
            </div>
            <UploadStatus status={uploads["full-track"]} signedIn={canUseStudio} />
          </div>
          <TextField title="Collector receives (one per line)" value={form.includes} onChange={(value) => set("includes", value)} multiline />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("release")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("experience")}>Continue</button>
          </div>
        </section>
      )}

      {workflow === "catalog" && step === "experience" && (
        <section style={card}>
          <Eyebrow red>Experiences</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>What it unlocks</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>Choose the music-native promise first. The protected delivery mechanism is handled underneath by the existing experience service.</p>
          <label style={label}>
            What does this track unlock?
            <select value={form.productType} onChange={(event) => set("productType", event.target.value)} style={field}>
              {Object.entries(EXPERIENCE_CATEGORIES).map(([value, category]) => <option key={value} value={value} disabled={!category.supported}>{category.label}{category.supported ? "" : " — coming soon"}</option>)}
            </select>
          </label>
          <TextField title="Experience name" value={form.experienceTitle} onChange={(value) => set("experienceTitle", value)} placeholder={experienceCategoryLabel(form.productType)} />
          <TextField title="Description" value={form.experienceDescription} onChange={(value) => set("experienceDescription", value)} multiline />
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--vc-bone-dim)" }}>
            Delivery · {experienceCategory(form.productType)?.deliveryType || "Not configured"}
          </p>
          {(() => {
            const deliveryType = experienceCategory(form.productType)?.deliveryType || "AUDIO";
            const fileAccept = deliveryType === "VIDEO" ? VIDEO_ACCEPT : deliveryType === "STEMS" || deliveryType === "DOWNLOAD" ? `${ARCHIVE_ACCEPT},${AUDIO_ACCEPT}` : AUDIO_ACCEPT;
            const hint = deliveryType === "VIDEO" ? "MP4, MOV or WebM" : deliveryType === "STEMS" || deliveryType === "DOWNLOAD" ? "ZIP, or WAV, AIFF, FLAC or MP3" : "WAV, AIFF, FLAC or MP3";
            const label = deliveryType === "VIDEO" ? "Experience video" : deliveryType === "STEMS" || deliveryType === "DOWNLOAD" ? "Experience file" : "Experience audio";
            return (
          <div style={{ marginTop: 16 }}>
            <p style={{ margin: "0 0 8px" }}>{label} (private) — what collectors unlock</p>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...ghostBtn, cursor: busy !== "" || !canUseStudio ? "not-allowed" : "pointer", opacity: busy !== "" || !canUseStudio ? 0.6 : 1 }}>
                {busy === "experience-audio" ? "Uploading…" : experienceAudio ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
                <input type="file" accept={fileAccept} disabled={busy !== "" || !canUseStudio} style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) uploadExperienceAudio(file); }} />
              </label>
              <span style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{`${hint} · ${formatMegabytes(MAX_FULL_TRACK_BYTES)} max · private · holders only`}</span>
            </div>
            <UploadStatus status={uploads["experience-audio"]} signedIn={canUseStudio} />
          </div>
            );
          })()}
          <p role="status" style={{ color: experienceAudio || fullTrack || editionGated ? "var(--vc-bone-dim)" : "var(--vc-crimson)", lineHeight: 1.6 }}>
            {experienceAudio
              ? `Holders unlock: ${experienceAudio.filename || experienceAudio.assetId}.`
              : fullTrack
                ? `Holders unlock: ${fullTrack.filename || fullTrack.assetId} (the full track). Upload experience audio above to unlock something else.`
                : editionGated
                  ? "This edition already unlocks private audio for holders."
                  : "Nothing for holders to unlock yet. Upload the experience audio above."}
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("track")}>Back</button>
            <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio} onClick={saveCatalogStructure}>{busy === "catalog" ? "Saving catalog…" : "Save catalog structure"}</button>
          </div>
          {!canUseStudio && <p role="status" style={{ color: "var(--vc-crimson)", marginTop: 12 }}>Connect and authenticate the artist wallet to save.</p>}
          {catalogStatus && <p role="status" style={{ color: catalogStatus.ok ? "var(--vc-bone-dim)" : "var(--vc-crimson)", marginTop: 12, lineHeight: 1.6 }}>{catalogStatus.message}</p>}
        </section>
      )}

      {workflow === "catalog" && step === "supply" && (
        <section style={card}>
          <Eyebrow red>Supply</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>How many relics</h2>
          <TextField title="Quantity" value={form.quantity} onChange={(value) => set("quantity", value)} placeholder="Blank or 0 for unlimited" />
          <TextField title="Price (wei)" value={form.priceWei} onChange={(value) => set("priceWei", value)} />
          <TextField title="Resale royalty (basis points, max 1000)" value={form.royaltyBps} onChange={(value) => set("royaltyBps", value)} />
          <p style={{ color: "var(--vc-bone-dim)" }}>Leave Quantity blank or 0 for an unlimited open edition. The edition stays open until the sale end time. A number above 0 is a fixed cap and cannot be changed after publish. Royalty is stored on VoidRelease1155V2 at publish and paid on later marketplace resales. It is ignored on the current V1 deployment, which has no ERC-2981.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("experience")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("preview")}>Continue</button>
          </div>
        </section>
      )}

      {workflow === "catalog" && step === "preview" && (
        <section style={card}>
          <Eyebrow red>Review</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>{form.releaseTitle || "Untitled release"}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 240px) 1fr", gap: 24, alignItems: "start", marginTop: 20 }}>
            {form.trackArtwork || form.releaseArtwork
              ? <img src={ipfsToHttp(form.trackArtwork || form.releaseArtwork)} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover" }} />
              : <div style={{ width: "100%", aspectRatio: "1", border: "1px dashed var(--vc-ash)", display: "grid", placeItems: "center", color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>No artwork yet</div>}
            <div>
              <p><strong>Artist</strong><br />{activeArtist?.name || form.artistName || "—"}</p>
              <p><strong>Release</strong><br />{form.releaseTitle || "—"}</p>
              <p><strong>Type</strong><br />EP</p>
              <p><strong>Collector receives</strong><br />{form.includes.split("\n").filter(Boolean).join(" · ") || "—"}</p>
              <p><strong>Experiences</strong><br />{form.experienceTitle || experienceCategoryLabel(form.productType)}</p>
              <p><strong>Supply</strong><br />{supplyLabel(form.quantity)}</p>
            </div>
          </div>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7, marginTop: 24 }}>Publishing creates the on-chain collectible for this release. No blockchain knowledge required.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("supply")}>Back</button>
            <button type="button" style={primaryBtn} onClick={() => setStep("publish")}>Publish release</button>
          </div>
        </section>
      )}

      {workflow === "catalog" && step === "publish" && (
        <section style={card}>
          <Eyebrow red>Publish</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Publish release</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
            Publishing creates your collectible release on The Void. Supply {supplyLabel(form.quantity)}. A published edition is fixed; an unlimited edition needs a new edition, not a change to one that already exists.
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

      {workflow === "catalog" && step === "sale" && (
        <section style={card}>
          <Eyebrow red>Set up sale</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Set up sale</h2>
          {!fujiPrimarySaleAddress() ? (
            <>
              <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
                VoidPrimarySale is not on this Fuji config yet. The collectible remains an ERC-1155. Fans pay native AVAX to the sale contract, which mints the edition. Until that contract is deployed, this step cannot open a public sale and Collect will not send an issuer mint.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
                <button type="button" style={ghostBtn} onClick={() => setStep("publish")}>Back</button>
              </div>
            </>
          ) : (
            <>
              <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
                Only the artist wallet recorded on this edition can configure its sale. Price is exact AVAX wei. Payment splits on-chain between the edition payout and the platform fee. Tokens are minted to the buyer. Nothing here is an ERC-20.
              </p>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", wordBreak: "break-all" }}>Published token · {publishedTokenId}</p>
              {configuredSale?.configured ? (
                <div role="status" style={{ border: "1px solid var(--vc-bone-dim)", padding: 16, marginTop: 18 }}>
                  <strong>Primary sale configured</strong>
                  <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7, marginBottom: 0 }}>
                    Price {formatAvax(configuredSale.priceWei)} · {configuredSale.maxSupply === 0n ? "No sale cap" : `${configuredSale.remaining.toString()} left of ${configuredSale.maxSupply.toString()}`} · {configuredSale.perWalletLimit === 0n ? "No per-wallet cap" : `${configuredSale.perWalletLimit.toString()} per wallet`}{configuredSale.paused ? " · Sale paused" : ""}
                  </p>
                </div>
              ) : (
                <>
                  <p style={{ color: "var(--vc-crimson)", lineHeight: 1.7 }}>This release does not have a primary sale yet. Configure it using the persisted published token above.</p>
                  <TextField title="Price (wei)" value={form.priceWei} onChange={(value) => set("priceWei", value)} />
                  <TextField title="Sale supply" value={form.saleSupply} onChange={(value) => set("saleSupply", value)} placeholder={isUnlimitedQuantity(form.quantity) ? "Blank or 0 for no sale cap" : (form.quantity || "Edition supply")} />
                  <TextField title="Per-wallet limit" value={form.perWalletLimit} onChange={(value) => set("perWalletLimit", value)} placeholder={isUnlimitedQuantity(form.quantity) ? "Blank or 0 for no per-wallet cap" : ""} />
                  <TextField title="Start time (e.g. 6:00am, an ISO datetime, or unix seconds — optional)" value={form.saleStart} onChange={(value) => set("saleStart", value)} placeholder="Leave blank for no start" />
                  <TextField title={isUnlimitedQuantity(form.quantity) ? "End time (required — this closes the edition)" : "End time (e.g. 11:59pm, an ISO datetime, or unix seconds — optional)"} value={form.saleEnd} onChange={(value) => set("saleEnd", value)} placeholder={isUnlimitedQuantity(form.quantity) ? "Required close time" : "Leave blank for no end"} required={isUnlimitedQuantity(form.quantity)} />
                  {isUnlimitedQuantity(form.quantity) && (
                    <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
                      This edition is unlimited. Leave sale supply blank or 0 if the sale itself should not cap copies. The end time is required: after it, purchases revert and no further copies are minted. There is no separate mint button.
                    </p>
                  )}
                  <label style={label}>
                    <input type="checkbox" checked={form.salePaused} onChange={(event) => set("salePaused", event.target.checked)} /> Paused
                  </label>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
                    <button type="button" style={ghostBtn} onClick={() => setStep("publish")}>Back</button>
                    <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio || !publishedTokenId} onClick={configureSale}>
                      {busy === "sale" ? "Configuring…" : "Configure Primary Sale"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
