import { useState, useRef, useEffect } from "react";
import { Wallet, LogOut } from "lucide-react";
import { useWallet } from "../lib/wallet-context.js";
import { shortAddr } from "../lib/web3.js";

// Brand-styled connect button + wallet picker dropdown for the Nav.
export function WalletButton({ compact }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const onClick = async () => {
    if (w.connected) { w.disconnect(); return; }
    if (w.wallets.length === 1) { await w.connect(w.wallets[0].provider); return; }
    if (w.wallets.length === 0) { await w.connect(); return; } // legacy window.ethereum
    setOpen((v) => !v);
  };

  const label = w.connected ? shortAddr(w.account) : "CONNECT";

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={onClick}
        title={w.connected ? w.account : "Connect wallet"}
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 500,
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          padding: compact ? "10px 14px" : "12px 16px",
          background: "transparent",
          border: "1px solid",
          borderColor: w.connected ? "var(--vc-crimson)" : "var(--vc-smoke)",
          color: w.connected ? "var(--vc-bone)" : "var(--vc-bone-dim)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          whiteSpace: "nowrap",
          transition: "all 120ms cubic-bezier(0.6,0,0.2,1)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--vc-crimson)"; e.currentTarget.style.color = "var(--vc-bone)"; }}
        onMouseLeave={(e) => { if (!w.connected) { e.currentTarget.style.borderColor = "var(--vc-smoke)"; e.currentTarget.style.color = "var(--vc-bone-dim)"; } }}
      >
        {w.connected
          ? <LogOut size={14} strokeWidth={1.75} />
          : <Wallet size={14} strokeWidth={1.75} />}
        {label}
      </button>

      {open && !w.connected && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 220,
            background: "rgba(10,10,11,0.98)",
            backdropFilter: "blur(14px)",
            border: "1px solid var(--vc-ash)",
            zIndex: 200,
            padding: 6,
          }}
        >
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--vc-crimson)", padding: "8px 10px 10px" }}>
            SELECT A BEARER WALLET
          </div>
          {w.wallets.length === 0 && (
            <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--vc-bone-dim)", padding: "8px 10px 12px" }}>
              No wallet detected.
            </div>
          )}
          {w.wallets.map((wallet) => (
            <button
              key={wallet.rdns || wallet.name}
              onClick={() => { w.connect(wallet.provider); setOpen(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 12, width: "100%",
                background: "transparent", border: "none", cursor: "pointer",
                padding: "10px", color: "var(--vc-bone)", textAlign: "left",
                transition: "background 120ms",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--vc-pit)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {wallet.icon && wallet.eip6963
                ? <img src={wallet.icon} alt="" width={22} height={22} style={{ display: "block" }} />
                : <Wallet size={22} strokeWidth={1.5} />}
              <span style={{ fontFamily: "var(--font-body)", fontWeight: 600, fontSize: 14 }}>{wallet.name}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
