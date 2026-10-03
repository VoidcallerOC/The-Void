import { useState } from "react";
import { useWallet } from "../lib/wallet-context.js";
import { requestProtectedMediaGrant } from "../lib/media-auth.js";
import { primaryBtn } from "../lib/marketplace-chrome.js";
import { useAudio } from "../lib/audio.js";

// Holder playback for a Studio experience's private audio. The client never
// decides access: the media gateway checks the signed-in wallet's on-chain
// balance before issuing a short-lived grant, and a non-holder is refused.
// The granted stream plays in the shared bottom player, never a second one.
export function ProtectedExperiencePlayer({ experience, title, art, collection }) {
  const wallet = useWallet() || {};
  const audio = useAudio();
  const [state, setState] = useState({ busy: false, error: "" });
  const signedIn = Boolean(wallet.connected && wallet.account);
  const queueId = `protected:${experience.id}`;
  const playing = audio.queueId === queueId && audio.playing;

  const unlock = async () => {
    if (audio.queueId === queueId && audio.isBearer(audio.queue?.[0])) {
      audio.toggle();
      return;
    }
    setState({ busy: true, error: "" });
    try {
      if (!wallet.authenticated) await wallet.authenticate?.();
      const grant = await requestProtectedMediaGrant({ wallet: wallet.account, experienceId: experience.id, mediaType: "AUDIO", authHeaders: wallet.authHeaders });
      const track = { n: "full", title: title || experience.title, art, protectedMedia: { experienceId: experience.id, mediaType: "AUDIO" } };
      setState({ busy: false, error: "" });
      await audio.playGranted(track, grant, queueId, collection || title || experience.title);
    } catch (error) {
      setState({ busy: false, error: error?.message || "Protected media authorization was denied." });
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      {signedIn ? (
        <button type="button" style={primaryBtn} disabled={state.busy} onClick={unlock}>{state.busy ? "Checking ownership…" : playing ? "Pause" : "Unlock & play"}</button>
      ) : (
        <p style={{ color: "var(--vc-bone-dim)" }}>Connect the wallet that holds this edition to unlock it.</p>
      )}
      {state.error && <p role="status" style={{ color: "var(--vc-crimson)", lineHeight: 1.6 }}>{state.error}</p>}
    </div>
  );
}
