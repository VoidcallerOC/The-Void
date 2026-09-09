import { useEffect, useMemo, useState } from "react";
import { Send } from "lucide-react";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { TransferModal } from "./TransferModal.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { fetchAllMetadata, CHAINS, FALLBACK_METADATA } from "../lib/web3.js";
import { VOIDCALLER_CATALOG } from "../data.js";
import { getCollectorLibrary, canAccessExperience } from "../lib/collection.js";

const chainKeyFor = (record) => record.chain?.key || Object.keys(CHAINS).find((key) => CHAINS[key].id === Number(record.chain?.id || record.chainId || record.chain)) || "cchain";

export function Reliquary() {
  const w = useWallet();
  const [meta, setMeta] = useState(FALLBACK_METADATA);
  const [transfer, setTransfer] = useState(null);
  useEffect(() => { let alive = true; fetchAllMetadata().then((items) => { if (alive) setMeta(items); }); return () => { alive = false; }; }, []);

  const library = useMemo(() => getCollectorLibrary(VOIDCALLER_CATALOG, w.ownershipRecords || []), [w.ownershipRecords]);
  const metadata = useMemo(() => Object.fromEntries(meta.map((item) => [String(item.tokenId), item])), [meta]);
  const totalQuantity = library.editions.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(96px, 14vw, 160px) clamp(20px, 5vw, 48px) clamp(120px, 16vw, 200px)" }}>
      <div className="vc-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 24, marginBottom: "clamp(32px, 6vw, 56px)" }}>
        <div><Eyebrow red>† MY COLLECTION</Eyebrow><h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", textTransform: "uppercase", lineHeight: 0.92, margin: "16px 0 0" }}>YOUR RECORDS</h1><p style={{ fontFamily: "var(--font-body)", fontSize: 15, color: "var(--vc-bone-dim)", maxWidth: 500, marginTop: 18, lineHeight: 1.6 }}>A music collection, not a wallet inventory. Releases, editions, and experiences are resolved from your on-chain holdings.</p></div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}><WalletButton />{w.connected && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>{w.loadingOwnership ? "READING THE CHAIN…" : `${totalQuantity} EDITION${totalQuantity === 1 ? "" : "S"} · ${library.artists.length} ARTIST${library.artists.length === 1 ? "" : "S"}`}</span>}</div>
      </div>

      {!w.connected ? <div style={{ textAlign: "center", padding: "72px 20px", border: "1px solid var(--vc-ash)" }}><p style={{ fontFamily: "var(--font-body)", color: "var(--vc-bone-dim)", marginBottom: 20 }}>Connect your wallet to reveal your music collection.</p><WalletButton /></div> : library.editions.length === 0 ? <div style={{ textAlign: "center", padding: "72px 20px", border: "1px solid var(--vc-ash)" }}><p style={{ fontFamily: "var(--font-body)", color: "var(--vc-bone-dim)" }}>{w.loadingOwnership ? "Reading supported chains…" : "No supported editions found for this wallet yet."}</p></div> : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 28 }}>{library.artists.map((artist) => <span key={artist.id} style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", border: "1px solid var(--vc-ash)", padding: "8px 10px", color: "var(--vc-bone-dim)" }}>{artist.name}</span>)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "clamp(16px, 2.5vw, 24px)" }}>
            {library.editions.map(({ edition, release, artist, holdings, quantity, experiences }) => {
              const first = holdings[0]; const chainKey = chainKeyFor(first); const experienceAccess = experiences.map((experience) => ({ ...experience, access: experience.access || { accessible: canAccessExperience(experience, holdings), label: canAccessExperience(experience, holdings) ? "UNLOCKED" : "LOCKED", reason: canAccessExperience(experience, holdings) ? "Your ownership satisfies this experience requirement." : "Hold the required edition to access this experience." } }));
              return <article key={edition.id} style={{ background: "var(--vc-abyss)", border: "1px solid var(--vc-ash)", borderTop: "2px solid var(--vc-crimson)", overflow: "hidden" }}>
                <img src={release?.artwork || metadata[String(first.tokenId)]?.image || ""} alt="" loading="lazy" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }} />
                <div style={{ padding: "18px" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>{artist?.name || "Artist"}</div><h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", lineHeight: 1, margin: "8px 0" }}>{release?.title || edition.title}</h2><div style={{ fontFamily: "var(--font-body)", color: "var(--vc-bone-dim)", fontSize: 14 }}>{edition.title} · {quantity} owned · {first.chain?.name || edition.chain}</div><div style={{ marginTop: 16, display: "grid", gap: 8 }}>{experienceAccess.map((experience) => <div key={experience.id} style={{ borderTop: "1px solid var(--vc-ash)", paddingTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: experience.access.accessible ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>{experience.access.label} · {experience.experienceType} · {experience.title}<div style={{ textTransform: "none", letterSpacing: 0, marginTop: 5, fontFamily: "var(--font-body)", fontSize: 12 }}>{experience.access.reason}</div></div>)}</div><button onClick={() => setTransfer({ name: `${artist?.name || "Asset"} · ${edition.title}`, tokenId: first.tokenId, amount: quantity, contract: first.contract, chainKey, image: metadata[String(first.tokenId)]?.image })} style={{ marginTop: 18, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", padding: "9px", background: "transparent", border: "1px solid var(--vc-ash)", color: "var(--vc-bone-dim)", cursor: "pointer" }}><Send size={12} /> SEND ASSET</button></div>
              </article>;
            })}
          </div>
        </>
      )}
      <TransferModal open={!!transfer} relic={transfer} chainKey={transfer?.chainKey} onClose={() => setTransfer(null)} />
    </section>
  );
}
