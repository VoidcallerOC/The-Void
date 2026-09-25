import { useEffect, useState } from "react";
import { useWallet } from "../lib/wallet-context.js";
import { fetchArtistVerification, requestArtistChallenge, submitArtistVerification, verificationBadgeVisible } from "../lib/contract-owner-verify.js";
import { switchChain } from "../lib/web3.js";
import { primaryBtn } from "../lib/marketplace-chrome.js";

export function VerifyArtistControl({ slug }) {
  const wallet = useWallet();
  const [record, setRecord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let live = true;
    fetchArtistVerification(slug).then((next) => { if (live) setRecord(next); }).catch(() => { if (live) setRecord({ verified: false }); });
    return () => { live = false; };
  }, [slug]);
  async function claim() {
    setBusy(true);
    setNotice("");
    try {
      if (!wallet.connected) await wallet.connect();
      const provider = wallet.getProvider?.() || wallet.provider;
      const account = wallet.account;
      if (!provider || !account) throw new Error("Connect a wallet first.");
      if (wallet.chainId !== 43114) {
        setNotice("Switch to Avalanche C-Chain. Signing a message costs no gas and sends no transaction.");
        await switchChain(provider, "cchain");
      }
      const challenge = await requestArtistChallenge(slug);
      const signature = await provider.request({ method: "personal_sign", params: [challenge.message, account] });
      const next = await submitArtistVerification({ slug, address: account, signature, nonce: challenge.nonce });
      setRecord(next);
      setNotice("On-chain owner() matched. Artist is verified.");
    } catch (error) {
      setNotice(error?.message || "Verification failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ marginTop: 18 }}>
      {verificationBadgeVisible(record) && (
        <a href={record.snowtrace} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
          <span style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase" }}>Verified artist</span>
        </a>
      )}
      {!record?.verified && (
        <>
          <button type="button" style={primaryBtn} disabled={busy} onClick={() => void claim()}>{busy ? "Checking owner()…" : "Verify artist"}</button>
          <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 12, marginTop: 10, maxWidth: 420 }}>Signs a one-time challenge. No gas, no transaction — the server reads owner() on the original mainnet contract.</p>
        </>
      )}
      {notice && <p style={{ color: "var(--vc-bone-dim)", marginTop: 8 }}>{notice}</p>}
    </div>
  );
}
