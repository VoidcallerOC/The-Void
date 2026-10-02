import { useState } from "react";
import { useAudio } from "../lib/audio.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";

// Plays one token's song in the site-wide player. Holders hear the full track
// through the protected-media gateway; everyone else hears the public preview.
export function PlayTokenButton({ track, queueId, collection = "", primary = false, label = "Play", style }) {
  const audio = useAudio();
  const [error, setError] = useState("");
  if (!track) return null;
  const active = audio.queueId === queueId && audio.queue?.[audio.idx] === track;
  const playing = active && audio.playing;
  const onClick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setError("");
    if (playing) { audio.pause(); return; }
    try {
      if (active) await audio.play();
      else { audio.setQueue([track], queueId, collection); await audio.play(0); }
    } catch {
      setError("Playback could not start. Check the browser's audio permission and try again.");
    }
  };
  return (
    <>
      <button type="button" aria-label={`${playing ? "Pause" : label} ${track.title}`} style={{ ...(primary ? primaryBtn : ghostBtn), ...style }} onClick={onClick}>
        {playing ? "❚❚ Pause" : `▶ ${label}`}
      </button>
      {error && <span role="status" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{error}</span>}
    </>
  );
}
