import { PlayTokenButton } from "./PlayTokenButton.jsx";
import { playableTrackFor } from "../lib/token-view.js";

export const PUBLIC_PREVIEW_LABEL = "Play public preview";
export const FULL_TRACK_UNAVAILABLE = "Full track unavailable";

// The one Play control for a token and its resolved playback (primaryPlayback / models.js).
// A resolved primary plays as before. When the edition designates a primary that does not
// resolve, the control is the explicitly labelled public preview: its track is built with no
// protected experience, so it carries no protected media reference (stripped even from built-in tracks that bring one) and can never request a
// grant, and a short notice says why the full track is not offered.
export function PrimaryPlayButton({ token, playback, queueId, collection = "", label = "Play", primary = false, artwork = "", unavailableStyle }) {
  if (playback.unavailable) {
    const full = playableTrackFor(token, { artwork });
    if (!full) return null;
    // Some built-in tracks carry their protected media pre-attached; the public preview never does.
    const track = { ...full };
    delete track.protectedMedia;
    return (
      <>
        <PlayTokenButton track={track} queueId={queueId} collection={collection} label={PUBLIC_PREVIEW_LABEL} />
        <span className="vc-card-meta" data-primary-state={playback.state} style={unavailableStyle}>{FULL_TRACK_UNAVAILABLE}</span>
      </>
    );
  }
  return <PlayTokenButton track={playableTrackFor(token, { artwork, protectedExperience: playback.experience })} protectedExperience={playback.experience} queueId={queueId} collection={collection} label={label} primary={primary} />;
}
