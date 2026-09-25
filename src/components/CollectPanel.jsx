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
  ensureFujiNetwork,
  explainCollectError,
  formatAvax,
  fujiPrimarySaleAddress,
  readPrimarySale,
} from "../lib/primary-sale.js";

function saleFacts(sale) {
  if (!fujiPrimarySaleAddress()) return "Primary sale is not configured on Fuji yet. This ERC-1155 cannot be bought until VoidPrimarySale is deployed.";
  if (!sale?.configured) return "This release does not have a primary sale yet.";
  const facts = [
    `Price ${formatAvax(sale.priceWei)}`,
    `${sale.remaining.toString()} left of ${sale.maxSupply.toString()}`,
    `${sale.perWalletLimit.toString()} per wallet`,
  ];
  if (sale.purchased > 0n) facts.push(`${sale.purchased.toString()} already collected by this wallet`);
  if (sale.paused) facts.push("Sale paused");
  return facts.join(" · ");
}

function collectLabel(sale, busy) {
  if (busy) return "Confirming…";
  if (!sale?.configured) return "Collect";
  if (sale.remaining === 0n) return "Sold out";
  if (sale.paused) return "Sale paused";
  if (sale.purchased >= sale.perWalletLimit) return "Wallet limit reached";
  return `Collect · ${formatAvax(sale.priceWei)}`;
}

export function CollectPanel({ edition, release, artist, experiences = [], catalog, variant = "panel" }) {
  const wallet = useWallet();
  const primary = primaryCollectForEdition(edition);
  const certified = isCertifiedFujiEdition(edition);
  const tokenId = edition?.tokenIds?.[0];
  const saleAddress = fujiPrimarySaleAddress();
  const [balance, setBalance] = useState(null);
  const [sale, setSale] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeState, setNoticeState] = useState("");
  const [txHash, setTxHash] = useState("");
  const [notCreated, setNotCreated] = useState(false);

  const library = useMemo(() => (catalog ? getCollectorLibrary(catalog, wallet.ownershipRecords || []) : null), [catalog, wallet.ownershipRecords]);
  const catalogOwned = Boolean(library?.editions?.some((item) => item.edition.id === edition.id));
  const fujiOwned = balance !== null && balance > 0n;
  const owned = certified ? fujiOwned : catalogOwned || primary.availability === "minted" && catalogOwned;
  const blocked = Boolean(sale?.configured && (sale.remaining === 0n || sale.paused || sale.purchased >= sale.perWalletLimit));

  useEffect(() => {
    let live = true;
    if (!certified || !wallet.connected || !wallet.account || tokenId === undefined) return undefined;
    const provider = wallet.getProvider();
    const reads = [readFujiEdition(provider, tokenId), readFujiBalance(provider, wallet.account, tokenId)];
    if (saleAddress) reads.push(readPrimarySale(provider, tokenId, wallet.account));
    Promise.all(reads)
      .then(([onChainEdition, value, onChainSale]) => {
        if (!live) return;
        setNotCreated(!onChainEdition?.exists);
        setBalance(value);
        setSale(onChainSale || null);
      })
      .catch((error) => {
        console.error("Fuji release preflight failed", error);
        if (!live) return;
        setNotCreated(isFujiEditionNotFoundError(error));
        if (!isFujiEditionNotFoundError(error)) {
          const explained = explainCollectError(error);
          setNotice(explained.message);
          setNoticeState(explained.state);
        }
        setBalance(0n);
        setSale(null);
      });
    return () => { live = false; };
  }, [certified, wallet, wallet.connected, wallet.account, tokenId, saleAddress]);

  const collect = async () => {
    setBusy("collect");
    setNotice("");
    setNoticeState("");
    setNotCreated(false);
    try {
      if (!wallet.account) throw new Error("Connect a wallet before collecting.");
      if (!wallet.authenticated) await wallet.authenticate();
      if (!certified) throw new Error("Primary collect for this edition is not on the certified Fuji contract.");
      if (!saleAddress) throw Object.assign(new Error("Primary sale is not configured on Fuji yet."), { state: "unconfigured" });
      const provider = wallet.getProvider();
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
      const onChainSale = await readPrimarySale(provider, tokenId, wallet.account);
      setSale(onChainSale);
      if (!onChainSale?.configured) throw Object.assign(new Error("This release does not have a primary sale yet."), { state: "unconfigured" });
      if (onChainSale.remaining === 0n) throw Object.assign(new Error("This release is sold out."), { state: "sold-out" });
      if (onChainSale.paused) throw Object.assign(new Error("This sale is paused."), { state: "paused" });
      if (onChainSale.purchased >= onChainSale.perWalletLimit) throw Object.assign(new Error("This wallet has reached the collector limit for this release."), { state: "wallet-limit" });
      const result = await collectEdition({ provider, from: wallet.account, tokenId, qty: 1, priceWei: onChainSale.priceWei });
      setTxHash(result.hash);
      const nextBalance = await readFujiBalance(provider, wallet.account, tokenId);
      setBalance(nextBalance);
      const refreshed = await readPrimarySale(provider, tokenId, wallet.account);
      setSale(refreshed);
      if (nextBalance <= 0n) throw new Error("The transaction confirmed, but ownership was not found on chain.");
      setNotice("Collect confirmed. This edition is now in your collection.");
      setNoticeState("confirmed");
      await wallet.refreshOwnership?.(wallet.account);
    } catch (error) {
      console.error("Collect preflight failed", error);
      if (isFujiEditionNotFoundError(error)) {
        setNotCreated(true);
      } else {
        const explained = error.state ? { state: error.state, message: error.message } : explainCollectError(error);
        setNotice(explained.message);
        setNoticeState(explained.state);
      }
    } finally {
      setBusy("");
    }
  };

  const experienceHref = experiences[0] ? `/experience/${experiences[0].id}` : "/reliquary";
  const confirmed = noticeState === "confirmed" || /confirm|owned/i.test(notice);
  const primaryOpensExperience = !owned && !notCreated && !certified && primary.availability === "minted";
  const action = owned ? (
    <span style={{ ...primaryBtn, cursor: "default" }}>Owned</span>
  ) : notCreated ? (
    <span style={ghostBtn}>Not yet available</span>
  ) : certified ? (
    <button type="button" style={primaryBtn} disabled={busy !== "" || !wallet.connected || blocked || !saleAddress} onClick={collect}>
      {collectLabel(sale, busy === "collect")}
    </button>
  ) : primary.availability === "minted" ? (
    <Link to={experienceHref} style={primaryBtn}>Open experience</Link>
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
      {certified && (
        <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>{saleFacts(sale)}</p>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
        {action}
        {variant === "hero" && experiences[0] && !primaryOpensExperience && <Link to={`/experience/${experiences[0].id}`} style={ghostBtn}>Open experience</Link>}
        {variant !== "hero" && owned && (
          <>
            <Link to={experienceHref} style={ghostBtn}>Open experience</Link>
            <Link to="/collection" style={ghostBtn}>My collection</Link>
          </>
        )}
      </div>
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
      {txHash && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", wordBreak: "break-all" }}>
          Receipt · <a href={fujiExplorerUrl("tx", txHash)} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{txHash}</a>
        </p>
      )}
    </>
  );

  if (variant === "hero") return <div>{status}</div>;

  return (
    <section style={{ marginTop: 48, border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: "28px 24px" }}>
      <Eyebrow red>Collectible release</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", textTransform: "uppercase", lineHeight: 0.95, margin: "12px 0" }}>
        {owned ? "Owned" : sale?.remaining === 0n ? "Sold out" : "Collect"}
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
