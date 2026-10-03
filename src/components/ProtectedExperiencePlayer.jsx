import { useState } from "react";
import { useWallet } from "../lib/wallet-context.js";
import { requestProtectedMediaGrant } from "../lib/media-auth.js";
import { primaryBtn } from "../lib/marketplace-chrome.js";

// Holder playback for a Studio experience's private audio. The client never
// decides access: the media gateway checks the signed-in wallet's on-chain
// balance before issuing a short-lived grant, and a non-holder is refused.
export function ProtectedExperiencePlayer({ experience }) {
  const wallet = useWallet() || {};
  const [state, setState] = useState({ busy: false, url: "", error: "" });
  const signedIn = Boolean(wallet.connected && wallet.account);

  const unlock = async () => {
    setState({ busy: true, url: "", error: "" });
    try {
      if (!wallet.authenticated) await wallet.authenticate?.();
      const grant = await requestProtectedMediaGrant({ wallet: wallet.account, experienceId: experience.id, mediaType: "AUDIO", authHeaders: wallet.authHeaders });
      setState({ busy: false, url: grant.accessUrl, error: "" });
    } catch (error) {
      setState({ busy: false, url: "", error: error?.message || "Protected media authorization was denied." });
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      {signedIn ? (
        <button type="button" style={primaryBtn} disabled={state.busy} onClick={unlock}>{state.busy ? "Checking ownership…" : "Unlock & play"}</button>
      ) : (
        <p style={{ color: "var(--vc-bone-dim)" }}>Connect the wallet that holds this edition to unlock it.</p>
      )}
      {state.error && <p role="status" style={{ color: "var(--vc-crimson)", lineHeight: 1.6 }}>{state.error}</p>}
      {state.url && (
        <div style={{ marginTop: 14 }}>
          <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>PROTECTED STREAM · SHORT-LIVED GRANT</p>
          <audio controls autoPlay src={state.url} style={{ width: "100%" }}>Your browser does not support protected audio playback.</audio>
        </div>
      )}
    </div>
  );
}
