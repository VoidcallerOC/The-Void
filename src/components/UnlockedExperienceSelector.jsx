import { useState } from "react";
import { sameTrack, useAudio } from "../lib/audio.js";
import { useWallet } from "../lib/wallet-context.js";
import { requestProtectedMediaGrant } from "../lib/media-auth.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";
import { KIND_LABEL, holderAudioOptions, holderTrackFor } from "../lib/holder-audio.js";

const ERROR_COPY = {
  EXPERIENCE_ENTITLEMENT_REQUIRED: "This wallet does not currently hold the edition. The full track and demo stay locked.",
  PROTECTED_MEDIA_NOT_CONFIGURED: "This audio is not attached to the release yet.",
  MEDIA_NOT_FOUND: "This audio is not attached to the release yet.",
  EXPERIENCE_NOT_FOUND: "This experience is no longer available.",
};

// Holder-only choice between the edition's full track and its demo. Ownership is
// decided by the media gateway when it issues the grant; this only picks which
// experience to request and hands the granted stream to the shared player.
export function UnlockedExperienceSelector({ experiences = [], token = null, collection = "", queuePrefix = "holder" }) {
  const audio = useAudio();
  const wallet = useWallet() || {};
  const [status, setStatus] = useState({ id: "", busy: false, error: "" });
  const options = holderAudioOptions(experiences);
  if (!token || !options.length) {
    return <p role="status" className="vc-card-meta" data-state="holder-audio-missing">Holder audio for this edition is not available yet. Only the public preview can play.</p>;
  }
  const select = async ({ experience, kind }) => {
    const track = holderTrackFor(token, experience, kind);
    const queueId = `${queuePrefix}:${experience.id}`;
    const active = audio.queueId === queueId && sameTrack(audio.queue?.[audio.idx], track);
    if (active && audio.isBearer(audio.queue[audio.idx])) { audio.toggle(); return; }
    // Switching: stop whatever is playing now (preview or the other experience) before authorizing the new one.
    audio.pause();
    setStatus({ id: experience.id, busy: true, error: "" });
    try {
      if (!wallet.connected || !wallet.account) throw new Error("Connect the wallet that holds this edition.");
      if (!wallet.authenticated) {
        const authentication = await wallet.authenticate?.();
        if (authentication?.error) throw new Error(authentication.error);
      }
      const mediaType = String(experience.media.type || "AUDIO").toUpperCase();
      const grant = await requestProtectedMediaGrant({ wallet: wallet.account, experienceId: experience.id, mediaType, authHeaders: wallet.authHeaders });
      setStatus({ id: experience.id, busy: false, error: "" });
      await audio.playGranted(track, grant, queueId, collection);
    } catch (error) {
      setStatus({ id: experience.id, busy: false, error: ERROR_COPY[error?.code] || error?.message || "Playback could not start. Try again." });
    }
  };
  return (
    <div role="group" aria-label="Holder audio" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {options.map((option) => {
          const queueId = `${queuePrefix}:${option.experience.id}`;
          const current = audio.queue?.[audio.idx];
          const selected = audio.queueId === queueId && audio.isBearer(current);
          const playing = selected && audio.playing;
          const busy = status.busy && status.id === option.experience.id;
          const text = `${KIND_LABEL[option.kind]} · ${option.experience.title}`;
          return (
            <button key={option.experience.id} type="button" aria-pressed={selected} data-kind={option.kind} disabled={busy} style={selected ? primaryBtn : ghostBtn} onClick={() => select(option)}>
              {busy ? `Checking ownership… ${text}` : `${playing ? "❚❚" : "▶"} ${text}`}
            </button>
          );
        })}
      </div>
      {status.error && <p role="status" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11, margin: 0 }}>{status.error}</p>}
    </div>
  );
}
