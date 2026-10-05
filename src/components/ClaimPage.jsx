import { useEffect, useState } from "react";
import { Eyebrow } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { LEGACY_CHAIN_ID } from "../lib/legacy-genesis.js";
import { CLAIM_ELIGIBLE_TOKEN_IDS, checkMainCollectionEligibility } from "../lib/claim-eligibility.js";
import { switchChain } from "../lib/web3.js";
import { useWallet } from "../lib/wallet-context.js";
import { ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";

const ELIGIBLE_TOKEN_RANGE = `${CLAIM_ELIGIBLE_TOKEN_IDS[0]}–${CLAIM_ELIGIBLE_TOKEN_IDS.at(-1)}`;

const STATE_COPY = {
  disconnected: {
    heading: "ACCESS REQUIRED",
    body: "Hold an original edition from The-Void main collection to claim.",
  },
  wrongNetwork: {
    heading: "WRONG NETWORK",
    body: "Switch to Avalanche C-Chain before we check access.",
  },
  checking: {
    heading: "CHECKING ELIGIBILITY",
    body: "Verifying main collection ownership on-chain.",
  },
  eligible: {
    heading: "ACCESS GRANTED",
    body: "You hold an eligible edition.",
  },
  ineligible: {
    heading: "ACCESS DENIED",
    body: `This claim is reserved for holders of The-Void main collection editions ${ELIGIBLE_TOKEN_RANGE}.`,
  },
  unavailable: {
    heading: "OWNERSHIP CHECK UNAVAILABLE",
    body: "We couldn't verify ownership. No access decision has been made. Retry the on-chain check.",
  },
};

const cardStyle = {
  border: "1px solid var(--vc-ash)",
  background: "var(--vc-abyss)",
  padding: "28px clamp(20px, 4vw, 32px)",
};

export function ClaimPage({ eligibilityReader = checkMainCollectionEligibility } = {}) {
  const wallet = useWallet();
  const [ownershipRead, setOwnershipRead] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");

  useEffect(() => {
    if (!wallet.connected || !wallet.account || wallet.chainId !== LEGACY_CHAIN_ID) return undefined;

    let live = true;
    Promise.resolve()
      .then(() => eligibilityReader(wallet.account))
      .then((result) => {
        if (live) setOwnershipRead({ account: wallet.account, chainId: wallet.chainId, retryCount, state: result?.eligible ? "eligible" : "ineligible" });
      })
      .catch(() => {
        if (live) setOwnershipRead({ account: wallet.account, chainId: wallet.chainId, retryCount, state: "unavailable" });
      });
    return () => { live = false; };
  }, [eligibilityReader, retryCount, wallet.account, wallet.chainId, wallet.connected]);

  const hasWallet = Boolean(wallet.connected && wallet.account);
  const readMatchesCurrentWallet = ownershipRead?.account === wallet.account
    && ownershipRead?.chainId === wallet.chainId
    && ownershipRead?.retryCount === retryCount;
  const state = !hasWallet
    ? "disconnected"
    : wallet.chainId !== LEGACY_CHAIN_ID
      ? "wrongNetwork"
      : readMatchesCurrentWallet ? ownershipRead.state : "checking";

  const switchToCChain = async () => {
    const provider = wallet.getProvider?.();
    if (!provider) {
      setSwitchError("Connect a wallet before switching networks.");
      return;
    }
    setSwitching(true);
    setSwitchError("");
    try {
      await switchChain(provider, "cchain");
    } catch {
      setSwitchError("The wallet could not switch networks. Select Avalanche C-Chain in your wallet, then try again.");
    } finally {
      setSwitching(false);
    }
  };

  const copy = STATE_COPY[state] || STATE_COPY.unavailable;

  return (
    <section style={{ ...shell, maxWidth: 920 }}>
      <header style={{ marginBottom: 38 }}>
        <Eyebrow red>Main collection · claim access</Eyebrow>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", lineHeight: 0.92, textTransform: "uppercase", margin: "16px 0" }}>
          Claim
        </h1>
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 620, lineHeight: 1.7, margin: 0 }}>
          Hold an original edition from The-Void main collection to claim.
        </p>
      </header>

      <section aria-labelledby="claim-state-heading" style={cardStyle}>
        <Eyebrow red>Ownership verification</Eyebrow>
        <div aria-live="polite" aria-atomic="true">
          <h2 id="claim-state-heading" style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 6vw, 52px)", textTransform: "uppercase", lineHeight: 0.95, margin: "14px 0 10px" }}>
            {copy.heading}
          </h2>
          <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65, margin: 0 }}>
            {copy.body}
          </p>
        </div>

        {state === "disconnected" && (
          <div style={{ marginTop: 22, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <WalletButton compact readOnly />
            <span style={{ color: "var(--vc-bone-dim)" }}>Connect a wallet to check access.</span>
          </div>
        )}

        {state === "wrongNetwork" && (
          <div style={{ marginTop: 22 }}>
            <button type="button" style={{ ...ghostBtn, opacity: switching ? 0.65 : 1 }} disabled={switching} onClick={() => void switchToCChain()}>
              {switching ? "SWITCHING…" : "SWITCH TO AVALANCHE C-CHAIN"}
            </button>
            {switchError && <p role="status" style={{ margin: "14px 0 0", color: "var(--vc-crimson)", lineHeight: 1.6 }}>{switchError}</p>}
          </div>
        )}

        {state === "unavailable" && (
          <div style={{ marginTop: 22, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" style={ghostBtn} onClick={() => setRetryCount((count) => count + 1)}>RETRY CHECK</button>
            <span style={{ color: "var(--vc-bone-dim)" }}>A failed read is not a denial.</span>
          </div>
        )}

        {state === "eligible" && (
          <div style={{ marginTop: 24, display: "grid", gap: 10, justifyItems: "start" }}>
            <button
              type="button"
              disabled
              aria-disabled="true"
              aria-describedby="claim-action-status"
              title="Claim action is not configured. No transaction will be sent."
              style={{ ...primaryBtn, background: "rgba(151, 19, 30, 0.48)", borderColor: "rgba(225, 15, 31, 0.5)", color: "rgba(255,255,255,0.72)", boxShadow: "none", cursor: "not-allowed" }}
            >
              CLAIM
            </button>
            <p id="claim-action-status" style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--vc-bone-dim)" }}>
              Claim action not configured · no transaction will be sent
            </p>
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--vc-ash)", marginTop: 26, paddingTop: 14, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)" }}>
          On-chain ownership · ERC-1155 · Avalanche C-Chain
        </div>
      </section>
    </section>
  );
}
