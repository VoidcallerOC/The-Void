import { useState } from "react";
import { sameTrack, useAudio } from "../lib/audio.js";
import { useWallet } from "../lib/wallet-context.js";
import { requestProtectedMediaGrant } from "../lib/media-auth.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";

// Plays one token's song in the site-wide player. Holders hear the full track
// through the protected-media gateway; everyone else hears the public preview.
export function PlayTokenButton({ track, queueId, collection = "", primary = false, label = "Play", style, protectedExperience = null, protectedOnly = false }) {
  const audio = useAudio();
  const wallet = useWallet() || {};
  const [error, setError] = useState("");
  if (!track) return null;
  const active = audio.queueId === queueId && sameTrack(audio.queue?.[audio.idx], track);
  const playing = active && audio.playing;
  const trackLabel = (active || audio.isBearer(track)) && track.protectedTitle ? track.protectedTitle : track.title;
  const onClick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setError("");
    if (playing) { audio.pause(); return; }
    try {
      // Resuming a bearer stream that is already loaded never asks for a new
      // grant (and never restarts the track).
      if (active && audio.isBearer(track)) { await audio.play(); return; }
      const protectedHolder = Boolean(track.protectedMedia && audio.isProtectedHolder(track));
      if (track.protectedMedia && (protectedOnly || protectedHolder)) {
        if (audio.hasAuthorizedSource(track)) {
          audio.setQueue([track], queueId, collection);
          await audio.play(0);
          return;
        }
        if (!wallet.connected || !wallet.account) throw new Error("Connect the wallet that holds this edition to play the full track.");
        if (!wallet.authenticated) {
          const authentication = await wallet.authenticate?.();
          if (authentication?.error) throw new Error(authentication.error);
        }
        const experienceId = protectedExperience?.id || track.protectedMedia.experienceId;
        const mediaType = protectedExperience?.media?.type || track.protectedMedia.mediaType || "AUDIO";
        const grant = await requestProtectedMediaGrant({ wallet: wallet.account, experienceId, mediaType, authHeaders: wallet.authHeaders });
        await audio.playGranted(track, grant, queueId, collection);
        return;
      }
      if (active) await audio.play();
      else { audio.setQueue([track], queueId, collection); await audio.play(0); }
    } catch (error) {
      setError(error?.message || "Playback could not start. Check the browser's audio permission and try again.");
    }
  };
  return (
    <>
      <button type="button" aria-label={`${playing ? "Pause" : label} ${trackLabel}`} style={{ ...(primary ? primaryBtn : ghostBtn), ...style }} onClick={onClick}>
        {playing ? "❚❚ Pause" : `▶ ${label}`}
      </button>
      {error && <span role="status" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{error}</span>}
    </>
  );
}
