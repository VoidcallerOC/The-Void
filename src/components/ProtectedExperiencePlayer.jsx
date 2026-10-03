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
  const [state, setState] = useState({ busy: false, error: "", accessUrl: "" });
  const signedIn = Boolean(wallet.connected && wallet.account);
  const queueId = `protected:${experience.id}`;
  const playing = audio.queueId === queueId && audio.playing;
  const mediaType = String(experience.media?.type || "AUDIO").toUpperCase();
  const contentType = String(experience.media?.contentType || "").toLowerCase();
  const playsAsVideo = mediaType === "VIDEO" || contentType.startsWith("video/");
  const playsAsAudio = !playsAsVideo && (mediaType === "AUDIO" || mediaType === "DEMO" || mediaType === "LIVE_RECORDING");

  const unlock = async () => {
    if (playsAsAudio && audio.queueId === queueId && audio.isBearer(audio.queue?.[0])) {
      audio.toggle();
      return;
    }
    setState({ busy: true, error: "", accessUrl: "" });
    try {
      if (!wallet.authenticated) await wallet.authenticate?.();
      const grant = await requestProtectedMediaGrant({ wallet: wallet.account, experienceId: experience.id, mediaType, authHeaders: wallet.authHeaders });
      if (!playsAsAudio) {
        setState({ busy: false, error: "", accessUrl: grant.accessUrl });
        return;
      }
      const track = { n: "full", title: title || experience.title, art, protectedMedia: { experienceId: experience.id, mediaType } };
      setState({ busy: false, error: "", accessUrl: "" });
      await audio.playGranted(track, grant, queueId, collection || title || experience.title);
    } catch (error) {
      setState({ busy: false, error: error?.message || "Protected media authorization was denied.", accessUrl: "" });
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      {signedIn ? (
        <button type="button" style={primaryBtn} disabled={state.busy} onClick={unlock}>{state.busy ? "Checking ownership…" : playing ? "Pause" : playsAsAudio ? "Unlock & play" : "Unlock"}</button>
      ) : (
        <p style={{ color: "var(--vc-bone-dim)" }}>Connect the wallet that holds this edition to unlock it.</p>
      )}
      {state.accessUrl && playsAsVideo && <video controls src={state.accessUrl} style={{ width: "100%", marginTop: 12 }} />}
      {state.accessUrl && mediaType !== "VIDEO" && <p style={{ marginTop: 12 }}><a href={state.accessUrl} style={{ color: "var(--vc-bone)" }}>Download</a></p>}
      {state.error && <p role="status" style={{ color: "var(--vc-crimson)", lineHeight: 1.6 }}>{state.error}</p>}
    </div>
  );
}
