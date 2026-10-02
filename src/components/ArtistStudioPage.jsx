import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { EXPERIENCE_CATEGORIES, experienceCategory, experienceCategoryLabel } from "../domain/models.js";
import { mapPublishedCatalog } from "../lib/catalog-source.js";
import { ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { FUJI_E2E_MINT, FUJI_RELEASE_CONFIG, FUJI_ROLES, assertFujiAddress, createFujiE2EMintPlan, encodeCreateFujiEdition, encodeFujiE2ECreateEdition, encodeFujiE2EMint, encodeFujiMint, fujiExplorerUrl, readFujiEdition, readFujiE2EMintPreflight, readFujiRole, sendFujiTransaction, simulateCreateFujiEdition, verifyFujiE2EMint, verifyFujiEditionCreation } from "../lib/fuji-release.js";
import { encodeConfigureSale, formatAvax, fujiPrimarySaleAddress, fujiReleaseIsV2, simulateConfigureSale, validateSaleSupply } from "../lib/primary-sale.js";
import { publicationResultMessage, studioPublicationPath, transactionEvidenceForOutcome, validateReleasePublish } from "../lib/studio-publish.js";
import { selectReleaseTemplate } from "../lib/studio-selection.js";
import { studioFetch } from "../lib/studio-api.js";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const field = { width: "100%", boxSizing: "border-box", marginTop: 7, padding: "12px 12px", minHeight: 44, color: "var(--vc-bone)", background: "var(--vc-pit)", border: "1px solid var(--vc-ash)", fontFamily: "var(--font-body)", fontSize: 16 };
const label = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", marginTop: 16 };
const STEPS = [
  ["release", "Your release"],
  ["track", "Tracks"],
  ["experience", "Experiences"],
];
const E2E_MINT_CHECKING_STATUS = { state: "checking", message: "Checking Fuji chain, artist and issuer roles, and that this run's test edition is unused…" };

function TextField({ title, value, onChange, multiline = false, required = false, placeholder = "", readOnly = false }) {
  const Tag = multiline ? "textarea" : "input";
  return (
    <label style={label}>
      {title}
      <Tag required={required} readOnly={readOnly} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} rows={multiline ? 4 : undefined} style={{ ...field, opacity: readOnly ? 0.7 : 1 }} />
    </label>
  );
}

function initialState() {
  return {
    artistName: "",
    artistBio: "",
    releaseTitle: "",
    releaseDescription: "",
    releaseArtwork: "/assets/voidcaller_art_5.png",
    trackTitle: "",
    trackDescription: "",
    trackArtwork: "/assets/voidcaller_art_4.png",
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

export function ArtistStudioPage() {
  const wallet = useWallet();
  const [params] = useSearchParams();
  const [ownedStudioCatalog, setOwnedStudioCatalog] = useState(null);
  const createIntent = params.get("create") === "track" ? "track" : "release";
  const [workflow, setWorkflow] = useState(createIntent === "track" ? "mint" : "catalog");
  const [form, setForm] = useState(initialState);
  const [step, setStep] = useState("release");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [artistId, setArtistId] = useState("");
  const [releaseId, setReleaseId] = useState("");
  const [editionId, setEditionId] = useState("");
  const [publishedTokenId, setPublishedTokenId] = useState("");
  const [notice, setNotice] = useState("");
  // On a failed Fuji transaction, hold the hash + explorer link so the user can
  // recover and inspect the exact transaction instead of losing it.
  const [txEvidence, setTxEvidence] = useState(null);
  const [busy, setBusy] = useState("");
  const [e2eMintStatus, setE2eMintStatus] = useState({ state: "hidden", message: "" });
  const [e2eMintPlan, setE2eMintPlan] = useState(() => createFujiE2EMintPlan());
  const [mintReleaseId, setMintReleaseId] = useState("");
  const [mintTrackIds, setMintTrackIds] = useState([]);
  const [mintEditionId, setMintEditionId] = useState("");
  const [mintAmount, setMintAmount] = useState("1");
  const [mintTxHashes, setMintTxHashes] = useState([]);
  const canUseStudio = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const set = (key, value) => setForm((prior) => ({ ...prior, [key]: value }));
  const walletAccount = wallet.account;
  const walletConnected = wallet.connected;
  const walletProvider = wallet.provider;
  const isE2EAdmin = walletAccount?.toLowerCase() === FUJI_E2E_MINT.wallet;
  const visibleE2eMintStatus = !isE2EAdmin || !walletConnected
    ? { state: "hidden", message: "" }
    : e2eMintStatus.state === "hidden"
      ? E2E_MINT_CHECKING_STATUS
      : e2eMintStatus;
  const existingReleases = useMemo(() => (ownedStudioCatalog?.releases || []).map((release) => ({
    release,
    artist: (ownedStudioCatalog.artists || []).find((artist) => artist.id === release.artistId) || null,
  })), [ownedStudioCatalog]);
  const selectedMintRelease = ownedStudioCatalog?.releases?.find((release) => release.id === mintReleaseId) || null;
  const mintEditions = (ownedStudioCatalog?.editions || []).filter((edition) => edition.releaseId === mintReleaseId);
  const selectedMintEdition = mintEditions.find((edition) => edition.id === mintEditionId) || null;
  const mintTracks = useMemo(() => {
    if (!selectedMintRelease) return [];
    if (Array.isArray(selectedMintRelease.tracks) && selectedMintRelease.tracks.length) return selectedMintRelease.tracks;
    return mintEditions.flatMap((edition) => (edition.tokenIds || []).map((tokenId) => ({ title: edition.title, tokenId: String(tokenId), experienceId: edition.experienceIds?.[0] || "" })));
  }, [selectedMintRelease, mintEditions]);

  useEffect(() => {
    let cancelled = false;
    if (!canUseStudio) return undefined;
    studioFetch("/studio/catalog", { headers })
      .then((payload) => { if (!cancelled) setOwnedStudioCatalog(mapPublishedCatalog(payload)); })
      .catch((error) => { if (!cancelled) setNotice(error.message); });
    return () => { cancelled = true; };
  }, [canUseStudio, headers]);

  useEffect(() => {
    let cancelled = false;
    if (!isE2EAdmin || !walletConnected) return undefined;
    void Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        return readFujiE2EMintPreflight(walletProvider, walletAccount, e2eMintPlan);
      })
      .then((result) => {
        if (!cancelled && result) setE2eMintStatus({ state: "ready", message: result.stage === "create" ? "Preflight passed. This run creates a fresh one-copy test edition, then mints it." : "Preflight passed. This run's test edition exists and is unminted.", result });
      })
      .catch((error) => { if (!cancelled) setE2eMintStatus({ state: "blocked", message: error.message }); });
    return () => { cancelled = true; };
  }, [isE2EAdmin, walletConnected, walletAccount, walletProvider, e2eMintPlan]);

  const mintE2ETestCopy = async () => {
    const plan = e2eMintPlan;
    setBusy("e2e-mint");
    try {
      const provider = wallet.getProvider?.();
      let preflight = await readFujiE2EMintPreflight(provider, wallet.account, plan);
      if (preflight.stage === "create") {
        setE2eMintStatus({ state: "confirming", message: "Rabby confirmation 1 of 2: create this run's one-copy test edition…" });
        const created = encodeFujiE2ECreateEdition(plan);
        await simulateCreateFujiEdition(provider, { from: wallet.account, data: created.data });
        const creation = await sendFujiTransaction({ provider, from: wallet.account, data: created.data });
        await verifyFujiEditionCreation(provider, { transactionHash: creation.hash, releaseId: plan.releaseId, editionId: plan.editionId, tokenId: plan.tokenId });
        preflight = await readFujiE2EMintPreflight(provider, wallet.account, plan);
      }
      if (preflight.stage !== "mint") throw new Error("The E2E test edition is not ready to mint.");
      setE2eMintStatus({ state: "confirming", message: "Rabby confirmation 2 of 2: mint exactly one copy of this run's test edition…" });
      const result = await sendFujiTransaction({ provider, from: wallet.account, data: encodeFujiE2EMint(plan) });
      const verified = await verifyFujiE2EMint(provider, { transactionHash: result.hash, plan });
      setE2eMintStatus({ state: "complete", message: `Mint confirmed. Seller balance verified at ${verified.balance.toString()}. Start a new run for another test edition.`, hash: result.hash });
    } catch (error) {
      setE2eMintStatus({ state: "blocked", message: error.message, hash: error.transactionHash || "" });
    } finally { setBusy(""); }
  };


  const ensureArtistAndRelease = async () => {
    if (!form.artistName) throw new Error("Enter an artist name before creating a release.");
    if (!form.releaseTitle) throw new Error("Enter a release title before creating a track.");
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
            metadata: { includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), artwork: form.trackArtwork },
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
    setBusy("catalog"); setNotice("");
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate an artist wallet first.");
      const ids = editionId ? { releaseId, editionId } : await saveDraft();
      if (!ids.editionId) throw new Error("Save the track draft before configuring its experience.");
      await studioFetch(`/studio/editions/${encodeURIComponent(ids.editionId)}/experiences`, {
        method: "POST",
        payload: {
          title: form.experienceTitle || experienceCategoryLabel(form.productType),
          description: form.experienceDescription,
          experienceType: experienceCategory(form.productType)?.deliveryType || "AUDIO",
          productType: form.productType,
          requirements: [],
          mediaConfig: {},
        },
        headers,
      });
      setNotice(`Catalog saved: ${form.releaseTitle || "Untitled release"} now contains its track and experience relationship.`);
      setStep("release");
    } catch (error) {
      setNotice(error.message);
    } finally { setBusy(""); }
  };

  const publishEdition = async () => {
    setBusy("publish"); setNotice(""); setTxEvidence(null);
    try {
      validateReleasePublish({
        release: { title: form.releaseTitle, type: "ep" },
        tracks: [{ title: form.trackTitle || form.releaseTitle }],
        supply: form.quantity,
        metadata: { artwork: form.releaseArtwork, includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean) },
      });
      const ids = await ensureArtistAndRelease();
      const saved = editionId ? { releaseId: ids.releaseId, editionId } : await saveDraft(ids);
      const metadata = await studioFetch(studioPublicationPath(saved.releaseId, "metadata"), {
        method: "POST",
        payload: { artwork: form.releaseArtwork, includes: form.includes.split("\n").map((line) => line.trim()).filter(Boolean), releaseType: "EP" },
        headers,
      });
      const provider = wallet.getProvider?.();
      if (!(await readFujiRole(provider, FUJI_ROLES.ARTIST_ROLE, wallet.account))) throw new Error("This authenticated artist wallet is not authorized to publish releases on Fuji.");
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
      const provider = wallet.getProvider?.();
      const edition = await readFujiEdition(provider, publishedTokenId);
      if (!edition?.exists) throw new Error("The published edition could not be found on Fuji. Refresh the edition before configuring its sale.");
      validateSaleSupply(form.saleSupply || form.quantity, edition.maxSupply);
      const data = encodeConfigureSale({
        tokenId: publishedTokenId,
        priceWei: form.priceWei,
        maxSupply: form.saleSupply || form.quantity,
        perWalletLimit: form.perWalletLimit,
        startTime: form.saleStart,
        endTime: form.saleEnd,
        paused: form.salePaused,
      });
      await simulateConfigureSale(provider, { from: wallet.account, data });
      const transaction = await sendFujiTransaction({ provider, from: wallet.account, data, to: sale });
      setNotice(`Sale configured at ${formatAvax(form.priceWei)}. Transaction confirmed: ${transaction.hash}`);
    } catch (error) {
      setNotice(error.message);
      setTxEvidence(transactionEvidenceForOutcome({ status: "failure", error, fallbackExplorerUrl: error?.transactionHash ? fujiExplorerUrl("tx", error.transactionHash) : null }));
    } finally {
      setBusy("");
    }
  };

  const mintSelectedTracks = async () => {
    setBusy("mint-tracks"); setNotice(""); setMintTxHashes([]); setTxEvidence(null);
    try {
      if (!canUseStudio) throw new Error("Connect and authenticate the artist wallet before minting.");
      if (!selectedMintRelease) throw new Error("Select an existing album or collection first.");
      if (!selectedMintEdition) throw new Error("Select the target contract for this catalog.");
      if (!mintTrackIds.length) throw new Error("Select at least one existing track.");
      const target = assertFujiAddress(selectedMintEdition.contractAddress);
      const provider = wallet.getProvider?.();
      if (!(await readFujiRole(provider, FUJI_ROLES.ISSUER_ROLE, wallet.account))) throw new Error("This authenticated artist wallet is not authorized to mint on the selected Fuji contract.");
      const selected = mintTracks.filter((track) => mintTrackIds.includes(String(track.tokenId)));
      const hashes = [];
      for (const track of selected) {
        if (track.tokenId === undefined || track.tokenId === null || track.tokenId === "") throw new Error(`Track ${track.title || "(untitled)"} has no token relationship yet.`);
        const transaction = await sendFujiTransaction({ provider, from: wallet.account, to: target, data: encodeFujiMint({ to: wallet.account, tokenId: track.tokenId, amount: mintAmount }) });
        hashes.push({ title: track.title, hash: transaction.hash });
      }
      setMintTxHashes(hashes);
      setNotice(`${hashes.length} token mint${hashes.length === 1 ? "" : "s"} confirmed on Fuji for ${selectedMintRelease.title}.`);
    } catch (error) {
      setNotice(error.message);
      setTxEvidence(transactionEvidenceForOutcome({ status: "failure", error, fallbackExplorerUrl: error?.transactionHash ? fujiExplorerUrl("tx", error.transactionHash) : null }));
    } finally { setBusy(""); }
  };

  const selectExistingRelease = (record) => {
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
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Select existing tracks and mint them on-chain.</p>
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

      {isE2EAdmin && wallet.connected && (
        <section style={{ ...card, marginBottom: 24, borderColor: "var(--vc-crimson)" }} aria-label="Temporary Fuji E2E mint control">
          <Eyebrow red>Temporary Fuji E2E control</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 30, margin: "10px 0 8px" }}>Mint E2E Test Copy</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7, margin: 0 }}>Admin-only test control. It submits no transaction until you click and approve the normal Rabby confirmation.</p>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.7, wordBreak: "break-all" }}>Test release: {e2eMintPlan.releaseId}<br />Test edition: {e2eMintPlan.editionId}<br />Token ID: {e2eMintPlan.tokenId.toString()}<br />Quantity: 1<br />Contract: {FUJI_RELEASE_CONFIG.contractAddress}</p>
          {visibleE2eMintStatus.message && <p role="status" style={{ color: visibleE2eMintStatus.state === "complete" || visibleE2eMintStatus.state === "ready" ? "var(--vc-bone-dim)" : "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{visibleE2eMintStatus.message}</p>}
          {visibleE2eMintStatus.hash && <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all" }}>TX: <a href={fujiExplorerUrl("tx", visibleE2eMintStatus.hash)} target="_blank" rel="noreferrer">{visibleE2eMintStatus.hash}</a></p>}
          <button type="button" style={primaryBtn} disabled={busy !== "" || visibleE2eMintStatus.state !== "ready"} onClick={mintE2ETestCopy}>{busy === "e2e-mint" ? "Confirming…" : "Mint E2E Test Copy"}</button>
          {visibleE2eMintStatus.state === "complete" && <button type="button" style={{ ...primaryBtn, marginLeft: 12 }} disabled={busy !== ""} onClick={() => { setE2eMintStatus({ state: "hidden", message: "" }); setE2eMintPlan(createFujiE2EMintPlan()); }}>Start New E2E Run</button>}
        </section>
      )}

      {workflow === "catalog" && <nav aria-label="Catalog editor workflow" className="vc-studio-steps">
        {STEPS.map(([id, title], index) => (
          <button key={id} type="button" onClick={() => setStep(id)} className={step === id ? "is-active" : ""}>
            <span>0{index + 1}</span> {title}
          </button>
        ))}
      </nav>}

      {notice && <div role="status" style={{ ...card, margin: "20px 0", borderColor: /saved|published|configured|confirmed/i.test(notice) ? "var(--vc-bone-dim)" : "var(--vc-crimson)" }}>{notice}</div>}
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
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>Your catalog is already defined. Select an existing album or collection, choose its tracks, select an authorized contract, then mint the token copies.</p>
          {!canUseStudio ? <p style={{ color: "var(--vc-crimson)" }}>Connect and authenticate the artist wallet to load your catalog.</p> : ownedStudioCatalog && !existingReleases.length ? <p style={{ color: "var(--vc-bone-dim)" }}>No albums or collections are available for this authenticated artist.</p> : null}
          <label style={label}>
            Select album / collection
            <select value={mintReleaseId} onChange={(event) => { setMintReleaseId(event.target.value); setMintEditionId(""); setMintTrackIds([]); }} style={field} disabled={!existingReleases.length}>
              <option value="">Choose an existing catalog record</option>
              {existingReleases.map(({ release, artist }) => <option key={release.id} value={release.id}>{artist?.name ? `${artist.name} — ` : ""}{release.title}</option>)}
            </select>
          </label>
          {selectedMintRelease && <>
            <label style={label}>Select tracks</label>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {mintTracks.length ? mintTracks.map((track) => {
                const id = String(track.tokenId ?? track.id ?? track.title);
                return <label key={id} style={{ ...label, marginTop: 0, display: "flex", gap: 10, alignItems: "center", textTransform: "none", letterSpacing: 0, fontSize: 14 }}><input type="checkbox" checked={mintTrackIds.includes(id)} onChange={() => setMintTrackIds((prior) => prior.includes(id) ? prior.filter((item) => item !== id) : [...prior, id])} /> {track.title || "Untitled track"}{track.experienceId ? ` · ${track.experienceId}` : ""}</label>;
              }) : <p style={{ color: "var(--vc-bone-dim)" }}>This catalog record has no track/token relationships yet. Define them in Create release first.</p>}
            </div>
            <label style={label}>
              Select target contract
              <select value={mintEditionId} onChange={(event) => setMintEditionId(event.target.value)} style={field}>
                <option value="">Choose a contract</option>
                {mintEditions.map((edition) => <option key={edition.id} value={edition.id} disabled={String(edition.contractAddress || "").toLowerCase() !== FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()}>{edition.contractAddress || "Contract not configured"} · chain {edition.chainId || "—"}</option>)}
              </select>
            </label>
            {selectedMintEdition && String(selectedMintEdition.contractAddress || "").toLowerCase() !== FUJI_RELEASE_CONFIG.contractAddress.toLowerCase() && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>This contract is not the certified Fuji mint target and is read-only in Artist Studio.</p>}
            <TextField title="Mint quantity per selected track" value={mintAmount} onChange={setMintAmount} required />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
              <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio || !mintTrackIds.length || !selectedMintEdition} onClick={mintSelectedTracks}>{busy === "mint-tracks" ? "Minting…" : "Mint token(s)"}</button>
              <button type="button" style={ghostBtn} onClick={() => { setWorkflow("catalog"); setStep("release"); }}>Back to catalog editor</button>
            </div>
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
          <TextField title="Artist name" value={form.artistName} onChange={(value) => set("artistName", value)} required />
          <TextField title="Artist bio" value={form.artistBio} onChange={(value) => set("artistBio", value)} multiline />
          <TextField title="Release title" value={form.releaseTitle} onChange={(value) => set("releaseTitle", value)} required />
          <TextField title="Description" value={form.releaseDescription} onChange={(value) => set("releaseDescription", value)} multiline />
          <TextField title="Artwork URL" value={form.releaseArtwork} onChange={(value) => set("releaseArtwork", value)} />
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
          <p style={{ color: "var(--vc-bone-dim)" }}>Release: {form.releaseTitle || "Select a release first"}</p>
          <TextField title="Track title" value={form.trackTitle} onChange={(value) => set("trackTitle", value)} placeholder="Defaults to the release title" />
          <TextField title="Description" value={form.trackDescription} onChange={(value) => set("trackDescription", value)} multiline />
          <TextField title="Artwork URL" value={form.trackArtwork} onChange={(value) => set("trackArtwork", value)} />
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
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <button type="button" style={ghostBtn} onClick={() => setStep("track")}>Back</button>
            <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio} onClick={saveCatalogStructure}>{busy === "catalog" ? "Saving catalog…" : "Save catalog structure"}</button>
          </div>
        </section>
      )}

      {workflow === "catalog" && step === "supply" && (
        <section style={card}>
          <Eyebrow red>Supply</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>How many relics</h2>
          <TextField title="Quantity" value={form.quantity} onChange={(value) => set("quantity", value)} required />
          <TextField title="Price (wei)" value={form.priceWei} onChange={(value) => set("priceWei", value)} />
          <TextField title="Resale royalty (basis points, max 1000)" value={form.royaltyBps} onChange={(value) => set("royaltyBps", value)} />
          <p style={{ color: "var(--vc-bone-dim)" }}>Quantity is the ERC-1155 edition supply. Royalty is stored on VoidRelease1155V2 at publish and paid on later marketplace resales. It is ignored on the current V1 deployment, which has no ERC-2981.</p>
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

      {workflow === "catalog" && step === "publish" && (
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
              <TextField title="Token id" value={publishedTokenId} onChange={setPublishedTokenId} readOnly={false} />
              <TextField title="Price (wei)" value={form.priceWei} onChange={(value) => set("priceWei", value)} />
              <TextField title="Sale supply" value={form.saleSupply} onChange={(value) => set("saleSupply", value)} placeholder={form.quantity || "Edition supply"} />
              <TextField title="Per-wallet limit" value={form.perWalletLimit} onChange={(value) => set("perWalletLimit", value)} />
              <TextField title="Start time (e.g. 6:00am, an ISO datetime, or unix seconds — optional)" value={form.saleStart} onChange={(value) => set("saleStart", value)} placeholder="Leave blank for no start" />
              <TextField title="End time (e.g. 11:59pm, an ISO datetime, or unix seconds — optional)" value={form.saleEnd} onChange={(value) => set("saleEnd", value)} placeholder="Leave blank for no end" />
              <label style={label}>
                <input type="checkbox" checked={form.salePaused} onChange={(event) => set("salePaused", event.target.checked)} /> Paused
              </label>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
                <button type="button" style={ghostBtn} onClick={() => setStep("publish")}>Back</button>
                <button type="button" style={primaryBtn} disabled={busy !== "" || !canUseStudio || !publishedTokenId} onClick={configureSale}>
                  {busy === "sale" ? "Configuring…" : "Set up sale"}
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </section>
  );
}
