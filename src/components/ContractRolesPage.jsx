import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Eyebrow } from "./Atoms.jsx";
import { OnChainRolesPanel } from "./VerifyPages.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { FUJI_RELEASE_CONFIG, FUJI_ROLES, readFujiRole } from "../lib/fuji-release.js";
import { shell } from "../lib/marketplace-chrome.js";

const field = { width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,.04)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", padding: "12px 14px", fontSize: 15, marginTop: 8, fontFamily: "var(--font-mono)" };
const muted = { color: "var(--vc-bone-dim)", lineHeight: 1.7, margin: 0 };

// /admin/roles: the certified Fuji contract's admin wallet grants an artist
// wallet the roles it needs to publish (ARTIST_ROLE) and mint (ISSUER_ROLE).
// The contract enforces who may grant; this page only builds the transaction.
export function ContractRolesPage() {
  const wallet = useWallet() || {};
  const [address, setAddress] = useState("");
  const [isAdmin, setIsAdmin] = useState(null);
  const account = wallet.account;
  const valid = ethers.isAddress(address.trim());

  useEffect(() => {
    const provider = wallet.connected ? wallet.getProvider?.() : null;
    if (!provider || !account) return undefined;
    let cancelled = false;
    readFujiRole(provider, FUJI_ROLES.DEFAULT_ADMIN_ROLE, account)
      .then((held) => { if (!cancelled) setIsAdmin(held); })
      .catch(() => { if (!cancelled) setIsAdmin(null); });
    return () => { cancelled = true; };
  }, [wallet.connected, account]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section style={shell}>
      <Eyebrow red>† Contract admin</Eyebrow>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(40px, 7vw, 72px)", margin: "12px 0 8px", textTransform: "uppercase" }}>Publishing roles</h1>
      <p style={{ ...muted, maxWidth: 680 }}>Grant an artist wallet the on-chain roles to publish (ARTIST_ROLE) and mint (ISSUER_ROLE) on the certified Fuji contract <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{FUJI_RELEASE_CONFIG.contractAddress}</span>. Only the contract&apos;s admin wallet can grant them.</p>
      <p style={{ ...muted, fontFamily: "var(--font-mono)", fontSize: 12, marginTop: 18 }}>
        {!wallet.connected ? "Connect the contract admin wallet (top right)." : `Connected: ${account} · contract admin ${isAdmin === null ? "…" : isAdmin ? "✓" : "✕ — this wallet cannot grant roles"}`}
      </p>
      <label style={{ display: "block", marginTop: 24, maxWidth: 680, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)" }}>
        Artist wallet address
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x…" style={field} spellCheck={false} />
      </label>
      {address.trim() && !valid && <p style={{ ...muted, color: "var(--vc-crimson)", marginTop: 10 }}>Enter a full 0x wallet address.</p>}
      <div style={{ maxWidth: 680 }}>
        {valid && <OnChainRolesPanel key={address.trim().toLowerCase()} artistWallet={ethers.getAddress(address.trim())} />}
      </div>
    </section>
  );
}
