import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import {
  FUJI_RELEASE_CONFIG,
  FUJI_ROLES,
  encodeFujiMint,
  fujiExplorerUrl,
  isCertifiedFujiEdition,
  isFujiEditionNotFoundError,
  readFujiBalance,
  readFujiEdition,
  readFujiPaused,
  readFujiRole,
  sendFujiTransaction,
} from "../lib/fuji-release.js";
import { getCollectorLibrary } from "../lib/collection.js";
import { primaryCollectForEdition } from "../lib/marketplace-surface.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";

export function CollectPanel({ edition, release, artist, experiences = [], catalog, variant = "panel" }) {
  const wallet = useWallet();
  const primary = primaryCollectForEdition(edition);
  const certified = isCertifiedFujiEdition(edition);
  const tokenId = edition?.tokenIds?.[0];
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [txHash, setTxHash] = useState("");
  const [issuer, setIssuer] = useState(null);
  const [notCreated, setNotCreated] = useState(false);

  const library = useMemo(() => (catalog ? getCollectorLibrary(catalog, wallet.ownershipRecords || []) : null), [catalog, wallet.ownershipRecords]);
  const catalogOwned = Boolean(library?.editions?.some((item) => item.edition.id === edition.id));
  const fujiOwned = balance !== null && balance > 0n;
  const owned = certified ? fujiOwned : catalogOwned || primary.availability === "minted" && catalogOwned;

  useEffect(() => {
    let live = true;
    if (!certified || !wallet.connected || !wallet.account || tokenId === undefined) return undefined;
    readFujiBalance(wallet.getProvider(), wallet.account, tokenId)
      .then((value) => { if (live) setBalance(value); })
      .catch(() => { if (live) setBalance(0n); });
    readFujiRole(wallet.getProvider(), FUJI_ROLES.ISSUER_ROLE, wallet.account)
      .then((value) => { if (live) setIssuer(value); })
      .catch(() => { if (live) setIssuer(false); });
    return () => { live = false; };
  }, [certified, wallet.connected, wallet.account, tokenId, wallet]);

  const collect = async () => {
    setBusy("collect");
    setNotice("");
    setNotCreated(false);
    try {
      if (!wallet.account) throw new Error("Connect a wallet before collecting.");
      if (!wallet.authenticated) await wallet.authenticate();
      if (!certified) throw new Error("Primary collect for this edition is not on the certified Fuji contract.");
      const provider = wallet.getProvider();
      const paused = await readFujiPaused(provider);
      if (paused) throw new Error("The certified Fuji release is paused. Collect is unavailable until it is unpaused.");
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
      const hasIssuer = await readFujiRole(provider, FUJI_ROLES.ISSUER_ROLE, wallet.account);
      setIssuer(hasIssuer);
      if (!hasIssuer) {
        throw new Error("This wallet does not have ISSUER_ROLE on VoidRelease1155. Primary collect is issuer-controlled. The transaction was not sent.");
      }
      const data = encodeFujiMint({ to: wallet.account, tokenId, amount: 1 });
      const result = await sendFujiTransaction({ provider, from: wallet.account, data });
      setTxHash(result.hash);
      const nextBalance = await readFujiBalance(provider, wallet.account, tokenId);
      setBalance(nextBalance);
      if (nextBalance <= 0n) throw new Error("The transaction confirmed, but ownership was not found on chain.");
      setNotice("Collect confirmed. This edition is now in your collection.");
      await wallet.refreshOwnership?.(wallet.account);
    } catch (error) {
      console.error("Collect preflight failed", error);
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  };

  const experienceHref = experiences[0] ? `/experience/${experiences[0].id}` : "/reliquary";

  if (variant === "hero") {
    return (
      <div>
        {!wallet.connected && (
          <div style={{ marginTop: 18, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <WalletButton />
            <span style={{ color: "var(--vc-bone-dim)" }}>Connect a wallet to collect or prove ownership.</span>
          </div>
        )}
        {wallet.connected && !wallet.authenticated && (
          <p style={{ color: "var(--vc-bone-dim)" }}>Authenticate the connected wallet before collecting.</p>
        )}
        {issuer === false && certified && !owned && (
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>
            The connected wallet does not have ISSUER_ROLE. Collect will not be faked. Connect an authorized issuer wallet.
          </p>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
          {owned ? (
            <span style={{ ...primaryBtn, cursor: "default" }}>Owned</span>
          ) : certified ? (
            <button type="button" style={primaryBtn} disabled={busy !== "" || !wallet.connected} onClick={collect}>
              {busy === "collect" ? "Confirming…" : "Collect"}
            </button>
          ) : primary.availability === "minted" ? (
            <Link to={experienceHref} style={primaryBtn}>Open experience</Link>
          ) : (
            <span style={ghostBtn}>Collect unavailable</span>
          )}
          {experiences[0] && <Link to={`/experience/${experiences[0].id}`} style={ghostBtn}>Open experience</Link>}
        </div>
        {notCreated && (
          <div role="status" style={{ marginTop: 18, color: "var(--vc-crimson)", lineHeight: 1.6 }}>
            <strong style={{ display: "block", letterSpacing: ".08em" }}>EDITION NOT YET CREATED</strong>
            <span style={{ display: "block", color: "var(--vc-bone-dim)", marginTop: 6 }}>This edition hasn&apos;t been created on Avalanche Fuji yet.</span>
            <Link to="/studio" style={{ ...primaryBtn, display: "inline-block", marginTop: 14 }}>OPEN ARTIST STUDIO</Link>
          </div>
        )}
        {notice && (
          <p role="status" style={{ marginTop: 18, color: notice.toLowerCase().includes("confirm") || notice.toLowerCase().includes("owned") ? "var(--vc-bone)" : "var(--vc-crimson)", lineHeight: 1.6 }}>
            {notice}
          </p>
        )}
        {txHash && (
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", wordBreak: "break-all" }}>
            Receipt · <a href={fujiExplorerUrl("tx", txHash)} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{txHash}</a>
          </p>
        )}
      </div>
    );
  }

  return (
    <section style={{ marginTop: 48, border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: "28px 24px" }}>
      <Eyebrow red>Primary collection</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", textTransform: "uppercase", lineHeight: 0.95, margin: "12px 0" }}>
        {owned ? "Owned" : "Collect"}
      </h2>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65 }}>
        {artist?.name} · {release?.title} · {edition.title}. {primary.note}
      </p>
      {certified && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".08em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
          Certified Fuji · {FUJI_RELEASE_CONFIG.networkName} · issuer-controlled mint
        </p>
      )}
      {!wallet.connected && (
        <div style={{ marginTop: 18, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <WalletButton />
          <span style={{ color: "var(--vc-bone-dim)" }}>Connect a wallet to collect or prove ownership.</span>
        </div>
      )}
      {wallet.connected && !wallet.authenticated && (
        <p style={{ color: "var(--vc-bone-dim)" }}>Authenticate the connected wallet before collecting.</p>
      )}
      {issuer === false && certified && !owned && (
        <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.65 }}>
          The connected wallet does not have ISSUER_ROLE. Collect will not be faked. Connect an authorized issuer wallet.
        </p>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
        {owned ? (
          <>
            <span style={{ ...primaryBtn, cursor: "default" }}>Owned</span>
            <Link to={experienceHref} style={ghostBtn}>Open experience</Link>
            <Link to="/collection" style={ghostBtn}>My collection</Link>
          </>
        ) : certified ? (
          <button type="button" style={primaryBtn} disabled={busy !== "" || !wallet.connected} onClick={collect}>
            {busy === "collect" ? "Confirming…" : "Collect"}
          </button>
        ) : primary.availability === "minted" ? (
          <Link to={experienceHref} style={primaryBtn}>Open experience</Link>
        ) : (
          <span style={ghostBtn}>Collect unavailable</span>
        )}
      </div>
      {notCreated && (
        <div role="status" style={{ marginTop: 18, color: "var(--vc-crimson)", lineHeight: 1.6 }}>
          <strong style={{ display: "block", letterSpacing: ".08em" }}>EDITION NOT YET CREATED</strong>
          <span style={{ display: "block", color: "var(--vc-bone-dim)", marginTop: 6 }}>This edition hasn&apos;t been created on Avalanche Fuji yet.</span>
          <Link to="/studio" style={{ ...primaryBtn, display: "inline-block", marginTop: 14 }}>OPEN ARTIST STUDIO</Link>
        </div>
      )}
      {notice && !notCreated && (
        <p role="status" style={{ marginTop: 18, color: notice.toLowerCase().includes("confirm") || notice.toLowerCase().includes("owned") ? "var(--vc-bone)" : "var(--vc-crimson)", lineHeight: 1.6 }}>
          {notice}
        </p>
      )}
      {txHash && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", wordBreak: "break-all" }}>
          Receipt · <a href={fujiExplorerUrl("tx", txHash)} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{txHash}</a>
        </p>
      )}
    </section>
  );
}
