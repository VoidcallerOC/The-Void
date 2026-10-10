import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import {
  FUJI_RELEASE_CONFIG,
  fujiExplorerUrl,
  isCertifiedFujiEdition,
  isFujiEditionNotFoundError,
  readFujiBalance,
  readFujiEdition,
  readFujiPaused,
} from "../lib/fuji-release.js";
import { getCollectorLibrary } from "../lib/collection.js";
import { primaryCollectForEdition } from "../lib/marketplace-surface.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";
import {
  collectEdition,
  collectReleaseEdition,
  createFujiPublicProvider,
  ensureFujiNetwork,
  explainCollectError,
  formatAvax,
  fujiPrimarySaleAddress,
  readPrimarySale,
  readReleasePrimarySale,
  saleIsSoldOut,
  walletLimitReached,
} from "../lib/primary-sale.js";
import { readReleaseBalance, readReleasePaused } from "../lib/release-asset.js";
import { loadPrimaryPurchaseEvidence, savePrimaryPurchaseEvidence } from "../lib/primary-purchase-evidence.js";
import { isReleasePerContractCandidate } from "../lib/secondary-listing.js";
import { SALE_AVAILABILITY, formatSaleTime, primarySaleAvailability, saleAvailabilityLabel } from "../lib/primary-sale-availability.js";

// The API's live sale tuple (decimal strings) in the shape readReleasePrimarySale returns.
function saleFromCatalog(value) {
  if (!value || value.configured !== true) return null;
  try {
    const maxSupply = BigInt(value.maxSupply);
    const sold = BigInt(value.sold);
    return {
      priceWei: BigInt(value.priceWei),
      maxSupply,
      sold,
      perWalletLimit: BigInt(value.perWalletLimit),
      startTime: BigInt(value.startTime),
      endTime: BigInt(value.endTime),
      paused: value.paused === true,
      configured: true,
      purchased: 0n,
      unlimited: maxSupply === 0n,
      remaining: maxSupply === 0n ? null : (maxSupply > sold ? maxSupply - sold : 0n),
    };
  } catch {
    return null;
  }
}

const CLOSED_WINDOW = new Set([SALE_AVAILABILITY.NOT_STARTED, SALE_AVAILABILITY.ENDED]);

function saleFacts(sale, saleAddress) {
  if (!saleAddress) return "Primary sale is not configured for this release yet.";
  if (!sale?.configured) return "This release does not have a primary sale yet.";
  const facts = [
    `Price ${formatAvax(sale.priceWei)}`,
    sale.maxSupply === 0n
      ? (sale.endTime > 0n ? `Open edition · until ${formatSaleTime(sale.endTime)}` : "Open edition")
      : `${sale.remaining.toString()} left of ${sale.maxSupply.toString()}`,
    sale.perWalletLimit === 0n ? "No per-wallet cap" : `${sale.perWalletLimit.toString()} per wallet`,
  ];
  if (sale.purchased > 0n) facts.push(`${sale.purchased.toString()} already collected by this wallet`);
  if (sale.paused) facts.push("Sale paused");
  return facts.join(" · ");
}

function collectLabel(sale, busy, availability) {
  if (busy) return "Confirming…";
  if (!sale?.configured) return "Collect";
  if (saleIsSoldOut(sale)) return "Sold out";
  if (sale.paused) return "Sale paused";
  if (CLOSED_WINDOW.has(availability?.state)) return saleAvailabilityLabel(availability);
  if (walletLimitReached(sale)) return "Wallet limit reached";
  return `Collect · ${formatAvax(sale.priceWei)}`;
}

export function CollectPanel({ edition, release, artist, experiences = [], catalog, variant = "panel" }) {
  const wallet = useWallet();
  const primary = primaryCollectForEdition(edition);
  const certified = isCertifiedFujiEdition(edition);
  const tokenId = edition?.tokenIds?.[0];
  const releaseAsset = useMemo(() => {
    const editionTokenId = edition?.tokenIds?.[0];
    return edition?.primarySaleAddress && edition?.contractAddress && editionTokenId !== undefined && editionTokenId !== null
      ? { chainId: edition.chainId, releaseContractAddress: edition.contractAddress, primarySaleAddress: edition.primarySaleAddress, tokenId: editionTokenId }
      : null;
  }, [edition]);
  const releaseScoped = Boolean(releaseAsset) && !certified;
  const collectorEnabled = certified || releaseScoped;
  const saleAddress = releaseScoped ? releaseAsset.primarySaleAddress : fujiPrimarySaleAddress();
  const [balance, setBalance] = useState(null);
  const [liveSale, setSale] = useState(null);
  // Until the chain is read, a release-scoped edition shows the API's sale state.
  const catalogSale = useMemo(() => (releaseScoped ? saleFromCatalog(edition?.primarySale) : null), [releaseScoped, edition?.primarySale]);
  const sale = liveSale || catalogSale;
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeState, setNoticeState] = useState("");
  const [sessionEvidence, setSessionEvidence] = useState(null);
  const [notCreated, setNotCreated] = useState(false);

  const library = useMemo(() => (catalog ? getCollectorLibrary(catalog, wallet.ownershipRecords || []) : null), [catalog, wallet.ownershipRecords]);
  const catalogOwned = Boolean(library?.editions?.some((item) => item.edition.id === edition.id));
  const onChainOwned = balance !== null && balance > 0n;
  const owned = collectorEnabled ? onChainOwned : catalogOwned || primary.availability === "minted" && catalogOwned;
  const resaleCandidate = isReleasePerContractCandidate(edition);
  const availability = sale?.configured ? primarySaleAvailability(sale, { editionSupply: edition?.supply }) : null;
  const blocked = Boolean(sale?.configured && (saleIsSoldOut(sale) || sale.paused || walletLimitReached(sale) || CLOSED_WINDOW.has(availability?.state)));

  const storedEvidence = useMemo(() => loadPrimaryPurchaseEvidence({ editionId: edition?.id, tokenId, purchaser: wallet.account }), [edition?.id, tokenId, wallet.account]);
  const purchaseEvidence = sessionEvidence?.editionId === edition?.id
    && sessionEvidence?.tokenId === String(tokenId)
    && sessionEvidence?.purchaser === String(wallet.account || "").toLowerCase()
    ? sessionEvidence
    : storedEvidence;

  // Without a wallet, a release-scoped Fuji edition still reads its own sale
  // through the public RPC, so an open edition is never shown as unavailable.
  useEffect(() => {
    let live = true;
    if (!releaseScoped || wallet.connected || Number(releaseAsset?.chainId) !== FUJI_RELEASE_CONFIG.chainId) return undefined;
    readReleasePrimarySale(createFujiPublicProvider(), releaseAsset, null)
      .then((onChainSale) => { if (live && onChainSale) setSale(onChainSale); })
      .catch((error) => console.error("Release sale read failed", error));
    return () => { live = false; };
  }, [releaseScoped, releaseAsset, wallet.connected]);

  useEffect(() => {
    let live = true;
    if (!collectorEnabled || !wallet.connected || !wallet.account || tokenId === undefined) return undefined;
    const provider = wallet.getProvider();
    const reads = certified
      ? [readFujiEdition(provider, tokenId), readFujiBalance(provider, wallet.account, tokenId), ...(saleAddress ? [readPrimarySale(provider, tokenId, wallet.account)] : [])]
      : [readReleaseBalance(provider, releaseAsset, wallet.account), readReleasePrimarySale(provider, releaseAsset, wallet.account)];
    Promise.all(reads)
      .then((results) => {
        if (!live) return;
        if (certified) {
          const [onChainEdition, value, onChainSale] = results;
          setNotCreated(!onChainEdition?.exists);
          setBalance(value);
          setSale(onChainSale || null);
        } else {
          const [value, onChainSale] = results;
          setNotCreated(false);
          setBalance(value);
          setSale(onChainSale || null);
        }
      })
      .catch((error) => {
        console.error("Release collect preflight failed", error);
        if (!live) return;
        const missing = certified && isFujiEditionNotFoundError(error);
        setNotCreated(missing);
        if (!missing) {
          const explained = explainCollectError(error);
          setNotice(explained.message);
          setNoticeState(explained.state);
        }
        setBalance(0n);
        setSale(null);
      });
    return () => { live = false; };
  }, [certified, collectorEnabled, releaseAsset, wallet, wallet.connected, wallet.account, tokenId, saleAddress]);

  const collect = async () => {
    setBusy("collect");
    setNotice("");
    setNoticeState("");
    setNotCreated(false);
    try {
      if (!wallet.account) throw new Error("Connect a wallet before collecting.");
      if (!wallet.authenticated) await wallet.authenticate();
      if (!collectorEnabled) throw new Error("Primary collect is not configured for this edition.");
      if (!saleAddress) throw Object.assign(new Error("Primary sale is not configured for this release yet."), { state: "unconfigured" });
      const provider = wallet.getProvider();
      let onChainSale;
      if (certified) {
        await ensureFujiNetwork(provider);
        const paused = await readFujiPaused(provider);
        if (paused) throw Object.assign(new Error("The certified Fuji release is paused. Collect is unavailable until it is unpaused."), { state: "paused" });
        let onChainEdition;
        try {
          onChainEdition = await readFujiEdition(provider, tokenId);
        } catch (error) {
          if (!isFujiEditionNotFoundError(error)) throw error;
          console.error("Fuji edition preflight: expected missing edition", error);
          setNotCreated(true);
          return;
        }
        if (!onChainEdition?.exists) {
          setNotCreated(true);
          return;
        }
        onChainSale = await readPrimarySale(provider, tokenId, wallet.account);
      } else {
        const paused = await readReleasePaused(provider, releaseAsset);
        if (paused) throw Object.assign(new Error("This release is paused. Collect is unavailable until it is unpaused."), { state: "paused" });
        onChainSale = await readReleasePrimarySale(provider, releaseAsset, wallet.account);
      }
      setSale(onChainSale);
      if (!onChainSale?.configured) throw Object.assign(new Error("This release does not have a primary sale yet."), { state: "unconfigured" });
      if (saleIsSoldOut(onChainSale)) throw Object.assign(new Error("This release is sold out."), { state: "sold-out" });
      if (onChainSale.paused) throw Object.assign(new Error("This sale is paused."), { state: "paused" });
      const saleWindow = primarySaleAvailability(onChainSale, { editionSupply: edition?.supply });
      if (CLOSED_WINDOW.has(saleWindow.state)) throw Object.assign(new Error(`This sale is not open right now. ${saleAvailabilityLabel(saleWindow)}.`), { state: "closed" });
      if (walletLimitReached(onChainSale)) throw Object.assign(new Error("This wallet has reached the collector limit for this release."), { state: "wallet-limit" });
      const result = certified
        ? await collectEdition({ provider, from: wallet.account, tokenId, qty: 1, priceWei: onChainSale.priceWei })
        : await collectReleaseEdition({ provider, from: wallet.account, releaseAsset, qty: 1, priceWei: onChainSale.priceWei });
      setSessionEvidence(savePrimaryPurchaseEvidence({
        transactionHash: result.hash,
        tokenId,
        editionId: edition.id,
        quantity: 1,
        priceWei: onChainSale.priceWei,
        purchaser: wallet.account,
      }));
      const nextBalance = certified
        ? await readFujiBalance(provider, wallet.account, tokenId)
        : await readReleaseBalance(provider, releaseAsset, wallet.account);
      setBalance(nextBalance);
      const refreshed = certified
        ? await readPrimarySale(provider, tokenId, wallet.account)
        : await readReleasePrimarySale(provider, releaseAsset, wallet.account);
      setSale(refreshed);
      if (nextBalance <= 0n) throw new Error("The transaction confirmed, but ownership was not found on chain.");
      setNotice("Collect confirmed. This edition is now in your collection.");
      setNoticeState("confirmed");
      await wallet.refreshOwnership?.(wallet.account);
      window.dispatchEvent(new Event("void:marketplace-volume-updated"));
    } catch (error) {
      console.error("Collect failed", error);
      // The edition preflight above already handles a missing edition. Anything
      // reaching here (usually a purchase revert) shows its real reason rather
      // than being mistaken for "not yet published".
      const explained = error.state ? { state: error.state, message: error.message } : explainCollectError(error);
      if (explained.state === "not-created") setNotCreated(true);
      else {
        setNotice(explained.message);
        setNoticeState(explained.state);
      }
    } finally {
      setBusy("");
    }
  };

  const linkedExperience = experiences.find((experience) => experience?.id);
  const experienceHref = linkedExperience ? `/experience/${linkedExperience.id}` : "/reliquary";
  const experienceLabel = linkedExperience ? "Open experience" : "Open reliquary";
  const confirmed = noticeState === "confirmed" || /confirm|owned/i.test(notice);
  const primaryOpensExperience = !owned && !notCreated && !collectorEnabled && primary.availability === "minted";
  // A release-scoped edition follows its own sale (supply 0 is an open edition);
  // the certified shared contract keeps its catalog availability.
  const primaryCollectReady = collectorEnabled && tokenId !== undefined && tokenId !== null
    && (releaseScoped ? Boolean(sale?.configured) || primary.availability === "available" : primary.availability === "available");
  const action = owned ? (
    <span style={{ ...primaryBtn, cursor: "default" }}>Owned</span>
  ) : notCreated ? (
    <span style={ghostBtn}>Not yet available</span>
  ) : primaryCollectReady ? (
    <button type="button" style={primaryBtn} disabled={busy !== "" || !wallet.connected || blocked || !saleAddress} onClick={collect}>
      {collectLabel(sale, busy === "collect", availability)}
    </button>
  ) : releaseScoped && !sale ? (
    <span style={ghostBtn}>{primary.saleLabel || "Checking sale…"}</span>
  ) : collectorEnabled ? (
    <span style={ghostBtn}>Not yet available</span>
  ) : primary.availability === "minted" ? (
    <Link to={experienceHref} style={primaryBtn}>{experienceLabel}</Link>
  ) : (
    <span style={ghostBtn}>Collect unavailable</span>
  );

  const status = (
    <>
      {!wallet.connected && (
        <div style={{ marginTop: 18, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <WalletButton />
          <span style={{ color: "var(--vc-bone-dim)" }}>Connect a wallet to collect or prove ownership.</span>
        </div>
      )}
      {wallet.connected && !wallet.authenticated && (
        <p style={{ color: "var(--vc-bone-dim)" }}>Authenticate the connected wallet before collecting.</p>
      )}
      {collectorEnabled && (
        <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>{saleFacts(sale, saleAddress)}</p>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
        {action}
        {variant === "hero" && linkedExperience && !primaryOpensExperience && <Link to={`/experience/${linkedExperience.id}`} style={ghostBtn}>Open experience</Link>}
        {owned && <Link to={`/edition/${edition.id}#secondary-listing`} style={primaryBtn}>List for sale</Link>}
        {variant !== "hero" && owned && (
          <>
            <Link to={experienceHref} style={ghostBtn}>{experienceLabel}</Link>
            <Link to="/my-collection" style={ghostBtn}>My collection</Link>
          </>
        )}
      </div>
      {owned && <p style={{ marginTop: 12, color: "var(--vc-bone-dim)", lineHeight: 1.6 }}>{resaleCandidate ? "You own this edition. You can list it for resale." : "You own this edition. Secondary resale is unavailable for this release."}</p>}
      {notCreated && (
        <div role="status" style={{ marginTop: 18, color: "var(--vc-crimson)", lineHeight: 1.6 }}>
          <strong style={{ display: "block", letterSpacing: ".08em" }}>NOT YET PUBLISHED</strong>
          <span style={{ display: "block", color: "var(--vc-bone-dim)", marginTop: 6 }}>This release hasn't been published on-chain yet.</span>
          <span style={{ display: "block", color: "var(--vc-bone-dim)", marginTop: 14 }}>COMING TO THE VOID · This release isn't collectible yet.</span>
        </div>
      )}
      {notice && !notCreated && (
        <p role="status" style={{ marginTop: 18, color: confirmed ? "var(--vc-bone)" : "var(--vc-crimson)", lineHeight: 1.6 }}>
          {notice}
        </p>
      )}
      {purchaseEvidence?.transactionHash && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", wordBreak: "break-all" }}>
          Receipt · <a href={fujiExplorerUrl("tx", purchaseEvidence.transactionHash)} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{purchaseEvidence.transactionHash}</a>
        </p>
      )}
    </>
  );

  if (variant === "hero") return <div>{status}</div>;

  return (
    <section style={{ marginTop: 48, border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: "28px 24px" }}>
      <Eyebrow red>Collectible release</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", textTransform: "uppercase", lineHeight: 0.95, margin: "12px 0" }}>
        {owned ? "Owned" : saleIsSoldOut(sale) ? "Sold out" : "Collect"}
      </h2>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65 }}>
        {artist?.name} · {release?.title} · {edition.title}. {primary.note}
      </p>
      {certified && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".08em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
          On-chain ownership verification · {FUJI_RELEASE_CONFIG.networkName} · ERC-1155
        </p>
      )}
      {status}
    </section>
  );
}
