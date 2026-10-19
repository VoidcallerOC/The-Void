import { useState, useRef, useEffect } from "react";
import { Wallet, LogOut, Network } from "lucide-react";
import { useWallet } from "../lib/wallet-context.js";
import { shortAddr } from "../lib/web3.js";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";
import { releaseNetworkRequiredMessage, releaseNetworkSwitchAllowed, releaseNetworkSwitchLabel } from "../lib/release-chain.js";

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

  const needsNetwork = Boolean(w.needsNetworkSwitch);
  // Collectors only ever see a switch control for the production network. On a testnet build the
  // wrong-network state is a notice: the wallet must be moved to the release network by hand.
  const switchAllowed = releaseNetworkSwitchAllowed(RELEASE_DEPLOYMENT);
  const switchLabel = releaseNetworkSwitchLabel(RELEASE_DEPLOYMENT, { allowSwitch: switchAllowed });
  const networkHint = releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "use The Void" });

  const onClick = async () => {
    if (needsNetwork) {
      if (switchAllowed) await w.ensureNetwork?.({ thenAuthenticate: true });
      return;
    }
    if (w.connected && w.authenticated) { w.disconnect(); return; }
    if (w.connected) { await w.authenticate(); return; }
    if (w.wallets.length === 1) { await w.connect(w.wallets[0].provider); return; }
    if (w.wallets.length === 0) { await w.connect(); return; } // legacy window.ethereum
    setOpen((v) => !v);
  };

  const label = w.authenticating
    ? "AUTHENTICATING"
    : needsNetwork
      ? switchLabel
      : w.connected
        ? (w.authenticated ? shortAddr(w.account) : "AUTH REQUIRED")
        : "CONNECT";

  const accessibleName = w.authenticating
    ? "Authenticating wallet"
    : needsNetwork
      ? (switchAllowed ? `Switch wallet to ${RELEASE_DEPLOYMENT.networkName}` : `Wrong network. ${networkHint}`)
      : w.connected
        ? (w.authenticated ? `Disconnect wallet ${shortAddr(w.account)}` : "Authenticate wallet")
        : "Connect wallet";

  const title = needsNetwork
    ? (w.authenticationError || networkHint)
    : w.authenticated
      ? w.account
      : w.connected
        ? (w.authenticationError || "Sign the wallet authentication message.")
        : `Connect · ${RELEASE_DEPLOYMENT.networkName} (${RELEASE_DEPLOYMENT.chainId}) required. If Rabby shows Ethereum first, approve connect, then approve the Avalanche switch.`;

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={onClick}
        aria-label={accessibleName}
        aria-disabled={needsNetwork && !switchAllowed ? "true" : undefined}
        title={title}
        data-needs-network={needsNetwork ? "true" : "false"}
        data-network-switch={needsNetwork && switchAllowed ? "true" : "false"}
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 500,
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          padding: compact ? "10px 14px" : "12px 16px",
          background: "transparent",
          border: "1px solid",
          borderColor: needsNetwork ? (switchAllowed ? "var(--vc-crimson)" : "var(--vc-ash)") : w.connected ? "var(--vc-crimson)" : "var(--vc-smoke)",
          color: needsNetwork ? (switchAllowed ? "var(--vc-bone)" : "var(--vc-bone-dim)") : w.connected ? "var(--vc-bone)" : "var(--vc-bone-dim)",
          cursor: needsNetwork && !switchAllowed ? "default" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          whiteSpace: "nowrap",
          transition: "all 120ms cubic-bezier(0.6,0,0.2,1)",
        }}
        onMouseEnter={(e) => {
          if (needsNetwork && !switchAllowed) return;
          e.currentTarget.style.borderColor = "var(--vc-crimson)"; e.currentTarget.style.color = "var(--vc-bone)";
        }}
        onMouseLeave={(e) => {
          if (!w.connected && !needsNetwork) {
            e.currentTarget.style.borderColor = "var(--vc-smoke)";
            e.currentTarget.style.color = "var(--vc-bone-dim)";
          }
        }}
      >
        {needsNetwork
          ? <Network size={14} strokeWidth={1.75} aria-hidden="true" />
          : w.connected
            ? w.authenticated ? <LogOut size={14} strokeWidth={1.75} aria-hidden="true" /> : <Wallet size={14} strokeWidth={1.75} aria-hidden="true" />
            : <Wallet size={14} strokeWidth={1.75} aria-hidden="true" />}
        <span aria-hidden="true">{label}</span>
      </button>

      {open && !w.connected && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: compact ? 0 : "auto",
            right: compact ? "auto" : 0,
            minWidth: 220,
            maxWidth: "min(280px, calc(100vw - 24px))",
            background: "rgba(10,10,11,0.98)",
            backdropFilter: "blur(14px)",
            border: "1px solid var(--vc-ash)",
            zIndex: 200,
            padding: 6,
          }}
        >
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--vc-ember)", padding: "8px 10px 4px", fontWeight: 500 }}>
            SELECT A BEARER WALLET
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--vc-bone)", padding: "0 10px 10px", lineHeight: 1.5 }}>
            {RELEASE_DEPLOYMENT.networkName} ({RELEASE_DEPLOYMENT.chainId}) · AVAX
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
