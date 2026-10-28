import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Minus, Plus, X } from "lucide-react";
import { useWallet } from "../lib/wallet-context.js";
import { fetchAllMetadata, ipfsToHttp } from "../lib/web3.js";
import { WalletButton } from "./WalletButton.jsx";
import {
  BRIDGE_CHAINS,
  BRIDGE_TOKEN_IDS,
  bridgeDirection,
  executeBridge,
  readBridgeBalances,
  switchBridgeChain,
} from "../lib/voidcaller-bridge.js";

const INITIAL_DIRECTION = "cchain-to-grotto";
const STEP_LABELS = {
  "cchain-to-grotto": ["Approve bridge contract", "Lock & send to The Grotto", "Awaiting ICM relay"],
  "grotto-to-cchain": ["Burn & send to C-Chain", "Awaiting ICM relay"],
};

const mono = { fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.14em" };
const body = { fontFamily: "var(--font-body)" };

export function BridgePage() {
  const wallet = useWallet();
  const [direction, setDirection] = useState(INITIAL_DIRECTION);
  const [metadata, setMetadata] = useState([]);
  const [balances, setBalances] = useState({ cchain: new Map(), grotto: new Map() });
  const [selected, setSelected] = useState(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const { from, to } = bridgeDirection(direction);
  const holdings = balances[from.key];
  const selectedEntries = [...selected.entries()].map(([tokenId, amount]) => [Number(tokenId), amount]).filter(([tokenId, amount]) => amount > 0 && (holdings.get(tokenId) || 0) >= amount);
  const total = selectedEntries.reduce((sum, [, amount]) => sum + amount, 0);

  useEffect(() => {
    let live = true;
    fetchAllMetadata().then((items) => { if (live) setMetadata(items); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    if (!wallet.account) {
      return undefined;
    }
    readBridgeBalances(wallet.account).then((next) => { if (live) setBalances(next); });
    return () => { live = false; };
  }, [wallet.account]);

  const items = useMemo(() => BRIDGE_TOKEN_IDS.map((tokenId) => metadata.find((item) => Number(item.tokenId) === tokenId) || { tokenId, name: `Relic #${tokenId}` }), [metadata]);

  const reverseDirection = () => {
    setDirection((value) => value === INITIAL_DIRECTION ? "grotto-to-cchain" : INITIAL_DIRECTION);
    setSelected(new Map());
    setError(null);
  };

  const toggle = (tokenId) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.set(tokenId, Math.min(holdings.get(tokenId) || 1, 1));
      return next;
    });
  };
  const setAmount = (tokenId, amount) => setSelected((current) => new Map(current).set(tokenId, Math.max(1, Math.min(amount, holdings.get(tokenId) || 1))));

  const bridge = async () => {
    if (!selectedEntries.length) { setError("Select at least one relic."); return; }
    const provider = wallet.getProvider?.();
    if (!provider || !wallet.account) { setError("No wallet connected."); return; }
    setBusy(true);
    setError(null);
    setProgress({ direction, count: total, steps: STEP_LABELS[direction].map((label) => ({ label, status: "" })) });
    try {
      if (wallet.chainId !== from.id) await switchBridgeChain(provider, from.key);
      await executeBridge({
        provider,
        account: wallet.account,
        direction,
        tokenIds: selectedEntries.map(([tokenId]) => tokenId),
        amounts: selectedEntries.map(([, amount]) => amount),
        onStep: (index, status) => setProgress((current) => current ? { ...current, steps: current.steps.map((step, i) => i === index ? { ...step, status } : step) } : current),
      });
      setSelected(new Map());
      await wallet.refreshOwnership?.();
      const next = await readBridgeBalances(wallet.account);
      setBalances(next);
    } catch (bridgeError) {
      setError(`Bridge failed: ${bridgeError?.message?.slice(0, 140) || "rejected"}`);
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(96px, 14vw, 160px) clamp(20px, 5vw, 48px) clamp(120px, 16vw, 200px)" }}>
      <div style={{ marginBottom: "clamp(32px, 6vw, 56px)" }}>
        <div style={{ ...mono, color: "var(--vc-crimson)", fontSize: 11 }}>† THE BRIDGE</div>
        <h1 style={{ ...body, fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", fontWeight: 400, textTransform: "uppercase", lineHeight: 0.92, margin: "16px 0 0", letterSpacing: "0.01em" }}>CROSS THE VEIL</h1>
        <p style={{ ...body, fontSize: 15, color: "var(--vc-bone-dim)", maxWidth: 520, marginTop: 18, lineHeight: 1.6 }}>Move your relics between Avalanche C-Chain and The Grotto via Inter-Chain Messaging. Bridging locks the relic on one side and mints its wrapped form on the other.</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: "clamp(28px, 5vw, 44px)" }}>
        <span style={{ ...mono, fontSize: 12, color: "var(--vc-bone)" }}>{from.short}</span>
        <button type="button" onClick={reverseDirection} aria-label="Reverse bridge direction" style={{ background: "transparent", border: "1px solid var(--vc-ash)", color: "var(--vc-bone-dim)", padding: 8, cursor: "pointer", display: "flex" }}><ArrowLeftRight size={16} strokeWidth={1.75} /></button>
        <span style={{ ...mono, fontSize: 12, color: "var(--vc-bone)" }}>{to.short}</span>
      </div>

      {!wallet.connected ? (
        <div style={{ textAlign: "center", marginTop: 40 }}>
          <p style={{ ...body, fontSize: 15, color: "var(--vc-bone-dim)", marginBottom: 20 }}>Connect your wallet to bridge relics.</p>
          <WalletButton compact />
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
            <span style={{ ...mono, fontSize: 11, color: "var(--vc-bone-dim)" }}>{holdings.size} RELIC KINDS ON {from.short}</span>
            <button type="button" onClick={() => setSelected(selected.size === holdings.size ? new Map() : new Map([...holdings].map(([id, amount]) => [id, amount])))} style={{ ...mono, fontSize: 11, background: "transparent", border: "none", padding: 0, color: "var(--vc-bone)", cursor: "pointer" }}>{selected.size === holdings.size ? "CLEAR" : "SELECT ALL"}</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "clamp(14px, 2vw, 20px)", marginBottom: 32 }}>
            {items.filter((item) => holdings.has(Number(item.tokenId))).map((item) => {
              const tokenId = Number(item.tokenId); const owned = holdings.get(tokenId) || 0; const isSelected = selected.has(tokenId); const amount = Math.min(selected.get(tokenId) || 0, owned);
              return <div key={tokenId} style={{ background: "var(--vc-abyss)", border: "1px solid var(--vc-ash)", borderTop: `2px solid ${isSelected ? "var(--vc-crimson)" : "var(--vc-ash)"}`, overflow: "hidden" }}>
                <button type="button" onClick={() => toggle(tokenId)} aria-pressed={isSelected} style={{ display: "block", width: "100%", background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: "inherit" }}>
                  <div style={{ position: "relative", aspectRatio: "1 / 1" }}><img src={ipfsToHttp(item.image)} alt={item.name} loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: isSelected ? 1 : 0.6 }} />{isSelected && <span style={{ position: "absolute", top: 8, right: 8, width: 20, height: 20, borderRadius: 999, background: "var(--vc-crimson)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>✓</span>}</div>
                  <div style={{ padding: "10px 12px" }}><div style={{ fontFamily: "var(--font-display)", fontSize: 16, textTransform: "uppercase", lineHeight: 1 }}>{item.name}</div><div style={{ ...mono, fontSize: 10, color: "var(--vc-bone-dim)", marginTop: 6, display: "flex", justifyContent: "space-between" }}><span>TOKEN #{tokenId}</span><span style={{ color: "var(--vc-bone)" }}>×{owned}</span></div></div>
                </button>
                {isSelected && owned > 1 && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: "1px solid var(--vc-ash)", padding: "8px 12px" }}><button type="button" aria-label={`Bridge one fewer ${item.name}`} disabled={amount <= 1} onClick={() => setAmount(tokenId, amount - 1)} style={{ background: "transparent", border: "1px solid var(--vc-ash)", padding: 6, display: "flex", color: amount <= 1 ? "var(--vc-ash)" : "var(--vc-bone)" }}><Minus size={14} /></button><span style={{ ...mono, fontSize: 12, color: "var(--vc-bone)" }}>{amount} OF {owned}</span><button type="button" aria-label={`Bridge one more ${item.name}`} disabled={amount >= owned} onClick={() => setAmount(tokenId, amount + 1)} style={{ background: "transparent", border: "1px solid var(--vc-ash)", padding: 6, display: "flex", color: amount >= owned ? "var(--vc-ash)" : "var(--vc-bone)" }}><Plus size={14} /></button></div>}
              </div>;
            })}
          </div>
          {!holdings.size && <p style={{ ...body, fontSize: 14, color: "var(--vc-bone-dim)", marginBottom: 24 }}>No relics on {from.short} to bridge.</p>}
          {error && <div role="alert" style={{ ...mono, fontSize: 12, color: "var(--vc-ember)", marginBottom: 16 }}>{error}</div>}
          <button type="button" onClick={bridge} disabled={busy || holdings.size === 0} style={{ ...mono, fontWeight: 700, fontSize: 12, padding: "14px 22px", border: "1px solid var(--vc-crimson)", cursor: busy || holdings.size === 0 ? "not-allowed" : "pointer", background: busy || holdings.size === 0 ? "transparent" : "var(--vc-crimson)", color: busy || holdings.size === 0 ? "var(--vc-ash)" : "#fff" }}>{busy ? "BRIDGING…" : `BRIDGE ${total || ""} RELIC${total === 1 ? "" : "S"}`}</button>
        </>
      )}

      {progress && <div role="dialog" aria-modal="true" aria-label="Bridge progress" onClick={(event) => { if (event.target === event.currentTarget && !busy) setProgress(null); }} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.82)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}><div style={{ width: "min(440px, 100%)", background: "var(--vc-abyss)", border: "1px solid var(--vc-ash)", borderTop: "2px solid var(--vc-crimson)", padding: "clamp(24px, 5vw, 36px)", position: "relative" }}>{!busy && <button type="button" onClick={() => setProgress(null)} aria-label="Close" style={{ position: "absolute", top: 16, right: 16, background: "transparent", border: "none", color: "var(--vc-bone-dim)", cursor: "pointer" }}><X size={20} /></button>}<div style={{ ...mono, fontSize: 11, color: "var(--vc-crimson)", marginBottom: 20 }}>BRIDGING {progress.count} RELIC{progress.count === 1 ? "" : "S"} · {BRIDGE_CHAINS[progress.direction === INITIAL_DIRECTION ? "cchain" : "grotto"].short} → {BRIDGE_CHAINS[progress.direction === INITIAL_DIRECTION ? "grotto" : "cchain"].short}</div><div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{progress.steps.map((step) => <div key={step.label} style={{ display: "flex", alignItems: "center", gap: 10, ...mono, fontSize: 12, color: step.status === "done" ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}><span style={{ width: 8, height: 8, borderRadius: 999, flexShrink: 0, background: step.status === "done" ? "var(--vc-bone)" : step.status === "active" ? "var(--vc-ember)" : "var(--vc-ash)" }} />{step.label}</div>)}</div></div></div>}
    </section>
  );
}
