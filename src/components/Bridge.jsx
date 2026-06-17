import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { Eyebrow, Btn } from "./Atoms.jsx";
import { Glitch } from "./Overlays.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useDialog } from "../lib/useDialog.js";
import { useWallet } from "../lib/wallet-context.js";
import {
  fetchAllMetadata,
  ipfsToHttp,
  switchChain,
  bridgeRoute,
  executeBridge,
} from "../lib/web3.js";

// Cross-chain relic bridge — locks/unlocks relics on C-Chain and mints/burns
// their wrapped counterpart on The Grotto via Avalanche ICM.
export function Bridge() {
  const w = useWallet();
  const [meta, setMeta] = useState([]);
  const [direction, setDirection] = useState("cchain-to-grotto");
  const [selected, setSelected] = useState(new Set());
  const [progress, setProgress] = useState(null); // { from, to, steps: [{label, status}] }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useDialog(!!progress, () => !busy && setProgress(null));

  useEffect(() => {
    let alive = true;
    fetchAllMetadata().then((m) => { if (alive) setMeta(m); });
    return () => { alive = false; };
  }, []);

  const { from, to } = bridgeRoute(direction);
  const sourceKey = from.key;
  const ownedSet = w.owned[sourceKey] || new Set();

  const toggleDirection = () => {
    setDirection((d) => (d === "cchain-to-grotto" ? "grotto-to-cchain" : "cchain-to-grotto"));
    setSelected(new Set());
    setError(null);
  };

  const toggleSelect = (tokenId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  };

  const stepLabels = direction === "cchain-to-grotto"
    ? ["Approve bridge contract", "Lock & send to The Grotto", "Awaiting ICM relay"]
    : ["Burn & send to C-Chain", "Awaiting ICM relay"];

  const submit = async () => {
    const tokenIds = [...selected];
    if (!tokenIds.length) { setError("Select at least one relic."); return; }
    const provider = w.getProvider();
    if (!provider) { setError("No wallet connected."); return; }
    setError(null);
    setBusy(true);
    setProgress({ from, to, steps: stepLabels.map((label) => ({ label, status: "" })) });
    try {
      if (w.chainId !== from.id) {
        await switchChain(provider, from.key);
      }
      await executeBridge({
        provider,
        account: w.account,
        direction,
        tokenIds,
        onStep: (index, status) => {
          setProgress((prev) => {
            if (!prev) return prev;
            const steps = prev.steps.map((s, i) => (i === index ? { ...s, status } : s));
            return { ...prev, steps };
          });
        },
      });
      setProgress((prev) => prev && {
        ...prev,
        steps: prev.steps.map((s, i) => (i === prev.steps.length - 1 ? { ...s, status: "done" } : s)),
      });
      setSelected(new Set());
      w.refreshOwnership();
    } catch (err) {
      setError("Bridge failed: " + (err?.message?.slice(0, 100) || "rejected"));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(96px, 14vw, 160px) clamp(20px, 5vw, 48px) clamp(120px, 16vw, 200px)" }}>
      <div style={{ marginBottom: "clamp(32px, 6vw, 56px)" }}>
        <Eyebrow red>† THE BRIDGE</Eyebrow>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", textTransform: "uppercase", lineHeight: 0.92, margin: "16px 0 0" }}>
          <Glitch size="clamp(48px, 9vw, 92px)" weight={400} style={{ letterSpacing: 0, lineHeight: 0.92 }}>CROSS THE VEIL</Glitch>
        </h1>
        <p style={{ fontFamily: "var(--font-body)", fontSize: 15, color: "var(--vc-bone-dim)", maxWidth: 480, marginTop: 18, lineHeight: 1.6 }}>
          Move your relics between Avalanche C-Chain and The Grotto via Inter-Chain Messaging. Bridging locks the relic on one side and mints its wrapped form on the other.
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: "clamp(28px, 5vw, 44px)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.14em", color: "var(--vc-bone)" }}>{from.short}</span>
        <button
          onClick={toggleDirection}
          aria-label="Reverse bridge direction"
          style={{ background: "transparent", border: "1px solid var(--vc-ash)", color: "var(--vc-bone-dim)", padding: 8, cursor: "pointer", display: "flex" }}
        >
          <ArrowRight size={16} strokeWidth={1.75} />
        </button>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.14em", color: "var(--vc-bone)" }}>{to.short}</span>
      </div>

      {!w.connected ? (
        <div style={{ textAlign: "center", marginTop: 40 }}>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 15, color: "var(--vc-bone-dim)", marginBottom: 20 }}>
            Connect your wallet to bridge relics.
          </p>
          <WalletButton />
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "clamp(14px, 2vw, 20px)", marginBottom: 32 }}>
            {meta.filter((relic) => ownedSet.has(relic.tokenId)).map((relic) => {
              const isSelected = selected.has(relic.tokenId);
              return (
                <button
                  key={relic.tokenId}
                  onClick={() => toggleSelect(relic.tokenId)}
                  style={{
                    background: "var(--vc-abyss)",
                    border: "1px solid var(--vc-ash)",
                    borderTop: isSelected ? "2px solid var(--vc-crimson)" : "2px solid var(--vc-ash)",
                    padding: 0, cursor: "pointer", textAlign: "left", overflow: "hidden",
                  }}
                >
                  <div style={{ position: "relative", aspectRatio: "1 / 1" }}>
                    <img
                      src={ipfsToHttp(relic.image)}
                      alt={relic.name}
                      loading="lazy"
                      decoding="async"
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: isSelected ? 1 : 0.6, transition: "opacity 120ms" }}
                    />
                    {isSelected && (
                      <span style={{ position: "absolute", top: 8, right: 8, width: 20, height: 20, borderRadius: 999, background: "var(--vc-crimson)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>
                        ✓
                      </span>
                    )}
                  </div>
                  <div style={{ padding: "10px 12px" }}>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 16, textTransform: "uppercase", lineHeight: 1 }}>{relic.name}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)", marginTop: 6 }}>TOKEN #{relic.tokenId}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {ownedSet.size === 0 && (
            <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--vc-bone-dim)", marginBottom: 24 }}>
              No relics on {from.short} to bridge.
            </p>
          )}

          {error && (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vc-ember)", marginBottom: 16 }}>
              {error}
            </div>
          )}

          <Btn onClick={busy ? undefined : submit} disabled={busy || ownedSet.size === 0}>
            {busy ? "BRIDGING…" : `BRIDGE ${selected.size || ""} RELIC${selected.size === 1 ? "" : "S"}`}
          </Btn>
        </>
      )}

      {progress && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setProgress(null); }}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.82)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Bridge progress"
            tabIndex={-1}
            style={{ width: "min(440px, 100%)", background: "var(--vc-abyss)", border: "1px solid var(--vc-ash)", borderTop: "2px solid var(--vc-crimson)", padding: "clamp(24px, 5vw, 36px)", position: "relative" }}
          >
            {!busy && (
              <button onClick={() => setProgress(null)} aria-label="Close" style={{ position: "absolute", top: 16, right: 16, background: "transparent", border: "none", color: "var(--vc-bone-dim)", cursor: "pointer" }}>
                <X size={20} strokeWidth={1.75} />
              </button>
            )}
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--vc-crimson)", marginBottom: 20 }}>
              BRIDGING {progress.from.short} → {progress.to.short}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {progress.steps.map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-mono)", fontSize: 12, color: step.status === "done" ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 999, flexShrink: 0,
                    background: step.status === "done" ? "var(--vc-bone)" : step.status === "active" ? "var(--vc-ember)" : "var(--vc-ash)",
                    boxShadow: step.status === "active" ? "0 0 8px var(--vc-ember)" : "none",
                    animation: step.status === "active" ? "vc-pulse 1.4s ease-in-out infinite" : "none",
                  }} />
                  {step.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
