import { useMemo, useState } from "react";
import { useWallet } from "../lib/wallet-context.js";
import { FUJI_INTEGRATION_CATALOG } from "../data.js";
import { requestProtectedMediaGrant } from "../lib/media-auth.js";
import { FUJI_RELEASE_CONFIG, FUJI_ROLES, encodeCreateFujiEdition, encodeFujiMint, fujiTokenId, readFujiBalance, readFujiPaused, readFujiRole, sendFujiTransaction, fujiExplorerUrl } from "../lib/fuji-release.js";

const edition = FUJI_INTEGRATION_CATALOG.editions[0];
const release = FUJI_INTEGRATION_CATALOG.releases[0];
const experience = FUJI_INTEGRATION_CATALOG.experiences[0];
const shell = { maxWidth: 1100, margin: "0 auto", padding: "clamp(120px, 16vw, 180px) clamp(20px, 5vw, 48px)" };
const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const button = { border: "1px solid var(--vc-crimson)", color: "var(--vc-bone)", background: "var(--vc-crimson)", padding: "11px 16px", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", cursor: "pointer" };

export function FujiIntegrationPage() {
  const wallet = useWallet();
  const [balance, setBalance] = useState(null);
  const [paused, setPaused] = useState(null);
  const [roles, setRoles] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [tx, setTx] = useState({ createEdition: "", mint: "" });
  const tokenId = useMemo(() => fujiTokenId(release.id, edition.id), []);
  const owned = balance !== null && balance > 0n;
  const ensureAuthenticated = async () => {
    if (!wallet.account) throw new Error("Connect a wallet first.");
    if (!wallet.authenticated) await wallet.authenticate();
  };

  const refresh = async () => {
    if (!wallet.provider || !wallet.account) throw new Error("Connect a wallet first.");
    const [nextBalance, nextPaused, artist, issuer] = await Promise.all([
      readFujiBalance(wallet.provider, wallet.account, tokenId),
      readFujiPaused(wallet.provider),
      readFujiRole(wallet.provider, FUJI_ROLES.ARTIST_ROLE, wallet.account),
      readFujiRole(wallet.provider, FUJI_ROLES.ISSUER_ROLE, wallet.account),
    ]);
    setBalance(nextBalance); setPaused(nextPaused); setRoles({ artist, issuer });
  };

  const createEdition = async () => {
    setBusy("create"); setNotice("");
    try {
      await ensureAuthenticated();
      const { tokenId: derived, data } = encodeCreateFujiEdition({ releaseId: release.id, editionId: edition.id, maxSupply: edition.supply, metadataUri: edition.metadataUri });
      const result = await sendFujiTransaction({ provider: wallet.getProvider(), from: wallet.account, data });
      setTx((prior) => ({ ...prior, createEdition: result.hash }));
      setNotice(`Edition confirmed on Fuji. Token ID ${derived.toString()}.`); await refresh();
    } catch (error) { setNotice(error.message); } finally { setBusy(""); }
  };

  const mint = async () => {
    setBusy("mint"); setNotice("");
    try {
      await ensureAuthenticated();
      const data = encodeFujiMint({ to: wallet.account, tokenId, amount: 1 });
      const result = await sendFujiTransaction({ provider: wallet.getProvider(), from: wallet.account, data });
      setTx((prior) => ({ ...prior, mint: result.hash }));
      const nextBalance = await readFujiBalance(wallet.getProvider(), wallet.account, tokenId);
      setBalance(nextBalance); setNotice(`Mint confirmed and balance verified: ${nextBalance.toString()}.`);
    } catch (error) { setNotice(error.message); } finally { setBusy(""); }
  };

  const grant = async () => {
    setBusy("grant"); setNotice("");
    try {
      if (!owned) throw new Error("The Fuji edition is locked until balanceOf confirms ownership.");
      await ensureAuthenticated();
      const result = await requestProtectedMediaGrant({ wallet: wallet.account, experienceId: experience.id, mediaType: "AUDIO", authHeaders: wallet.authHeaders });
      setMediaUrl(result.accessUrl); setNotice(`Protected media grant confirmed: ${result.grantId}.`);
    } catch (error) { setNotice(error.message); } finally { setBusy(""); }
  };

  return <section style={shell}><header style={{ maxWidth: 760, marginBottom: 42 }}><p style={{ fontFamily: "var(--font-mono)", color: "var(--vc-crimson)", fontSize: 11, letterSpacing: ".18em" }}>† CERTIFIED FUJI INTEGRATION · STAGING ONLY</p><h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(50px, 9vw, 90px)", textTransform: "uppercase", lineHeight: .9, margin: "18px 0" }}>{release.title}</h1><p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>This is the Summit demo path: discover, collect, verify ownership, then unlock one protected session. It never reports success before an on-chain receipt.</p></header><div style={{ ...card, marginBottom: 16 }}><strong>Certified contract</strong><p style={{ color: "var(--vc-bone-dim)", wordBreak: "break-all" }}>{FUJI_RELEASE_CONFIG.contractAddress} · chain {FUJI_RELEASE_CONFIG.chainId}</p><p style={{ color: "var(--vc-bone-dim)", wordBreak: "break-all" }}>Token ID: {tokenId.toString()}</p><p style={{ color: "var(--vc-bone-dim)" }}>Status: {paused === null ? "Not read" : paused ? "PAUSED" : "ACTIVE"} · Ownership: {balance === null ? "Not read" : owned ? `OWNED (${balance.toString()})` : "LOCKED"}</p></div>{!wallet.connected && <div style={{ ...card, borderColor: "var(--vc-crimson)", marginBottom: 16 }}>Connect an authorized Fuji wallet to exercise the real transaction path.</div>}<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}><section style={card}><h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase" }}>Edition lifecycle</h2><p style={{ color: "var(--vc-bone-dim)" }}>Artist role → createEdition → receipt → deterministic token ID.</p><button style={button} disabled={busy !== "" || !wallet.connected} onClick={createEdition}>{busy === "create" ? "CONFIRMING…" : "CREATE EDITION ON FUJI"}</button><p><button style={{ ...button, marginTop: 12, background: "transparent" }} disabled={busy !== "" || !wallet.connected} onClick={mint}>{busy === "mint" ? "CONFIRMING…" : "COLLECT TO CONNECTED WALLET"}</button></p></section><section style={card}><h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase" }}>Ownership and experience</h2><p style={{ color: "var(--vc-bone-dim)" }}>Direct balanceOf → owner unlock; non-owner remains locked.</p><button style={button} disabled={busy !== "" || !wallet.connected} onClick={refresh}>READ FUJI OWNERSHIP</button><p><button style={{ ...button, marginTop: 12, background: "transparent" }} disabled={busy !== "" || !owned} onClick={grant}>{busy === "grant" ? "AUTHORIZING…" : "UNLOCK SUMMIT SESSION"}</button></p></section></div>{roles && <p style={{ ...card, marginTop: 16, color: "var(--vc-bone-dim)" }}>Connected wallet roles: artist={String(roles.artist)} · issuer={String(roles.issuer)}</p>}{notice && <div role="status" style={{ ...card, marginTop: 16, borderColor: notice.includes("confirmed") ? "var(--vc-bone-dim)" : "var(--vc-crimson)" }}>{notice}</div>}{mediaUrl && <div style={{ ...card, marginTop: 16 }}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>PROTECTED STREAM · SHORT-LIVED GRANT</p><audio controls src={mediaUrl} style={{ width: "100%" }}>Your browser does not support protected audio playback.</audio></div>}<div style={{ ...card, marginTop: 16, color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{tx.createEdition && <div>CREATE EDITION: <a href={fujiExplorerUrl("tx", tx.createEdition)} target="_blank" rel="noreferrer">{tx.createEdition}</a></div>}{tx.mint && <div>MINT: <a href={fujiExplorerUrl("tx", tx.mint)} target="_blank" rel="noreferrer">{tx.mint}</a></div>}</div></section>;
}
