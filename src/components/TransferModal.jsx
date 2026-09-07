import { useState } from "react";
import { X } from "lucide-react";
import { Btn } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { CHAINS, ipfsToHttp, encodeTransfer, isValidAddress, switchChain } from "../lib/web3.js";

// Send a relic to another address (ERC-1155 safeTransferFrom).
export function TransferModal({ open, relic, chainKey, onClose }) {
  const w = useWallet();
  const [to, setTo] = useState("");
  const [status, setStatus] = useState(null); // {msg, kind}
  const [busy, setBusy] = useState(false);

  if (!open || !relic) return null;
  const chain = CHAINS[chainKey] || CHAINS.cchain;

  const submit = async () => {
    const recipient = to.trim();
    if (!isValidAddress(recipient)) { setStatus({ msg: "Enter a valid 0x address.", kind: "error" }); return; }
    if (recipient.toLowerCase() === w.account?.toLowerCase()) { setStatus({ msg: "Cannot send to yourself.", kind: "error" }); return; }

    const provider = w.getProvider();
    if (!provider) { setStatus({ msg: "No wallet connected.", kind: "error" }); return; }

    setBusy(true);
    try {
      if (w.chainId !== chain.id) {
        setStatus({ msg: `Switch to ${chain.name}…`, kind: "" });
        await switchChain(provider, chain.key);
      }
      setStatus({ msg: "Confirm in your wallet…", kind: "" });
      const data = encodeTransfer(w.account, recipient, relic.tokenId);
      await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: w.account, to: chain.contract, data }],
      });
      setStatus({ msg: "Sent. Waiting for confirmation…", kind: "success" });
      setTimeout(() => { w.refreshOwnership(); onClose(); }, 8000);
    } catch (err) {
      setStatus({ msg: "Transfer failed: " + (err?.message?.slice(0, 80) || "rejected"), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.82)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div style={{ width: "min(440px, 100%)", background: "var(--vc-abyss)", border: "1px solid var(--vc-ash)", borderTop: "2px solid var(--vc-crimson)", padding: "clamp(24px, 5vw, 36px)", position: "relative" }}>
        <button onClick={onClose} style={{ position: "absolute", top: 16, right: 16, background: "transparent", border: "none", color: "var(--vc-bone-dim)", cursor: "pointer" }}>
          <X size={20} strokeWidth={1.75} />
        </button>

        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--vc-crimson)", marginBottom: 20 }}>
          SEND RELIC
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
          <img src={ipfsToHttp(relic.image)} alt="" style={{ width: 64, height: 64, objectFit: "cover", border: "1px solid var(--vc-ash)", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, textTransform: "uppercase", lineHeight: 1 }}>{relic.name}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", marginTop: 6 }}>TOKEN #{relic.tokenId} · {chain.short}</div>
          </div>
        </div>

        <label style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--vc-bone-dim)", display: "block", marginBottom: 8 }}>
          RECIPIENT ADDRESS
        </label>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          style={{
            width: "100%", boxSizing: "border-box", background: "var(--vc-void)",
            border: "1px solid var(--vc-ash)", color: "var(--vc-bone)",
            fontFamily: "var(--font-mono)", fontSize: 13, padding: "12px 14px", marginBottom: 18,
          }}
        />

        {status && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, marginBottom: 16, color: status.kind === "error" ? "var(--vc-ember)" : status.kind === "success" ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>
            {status.msg}
          </div>
        )}

        <Btn onClick={busy ? undefined : submit} disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
          {busy ? "SENDING…" : "CONFIRM TRANSFER"}
        </Btn>
      </div>
    </div>
  );
}
