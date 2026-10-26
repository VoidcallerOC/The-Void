import { ipfsToHttp } from "./web3.js";
import { playableTrackFor } from "./token-view.js";

const AUDIO_TYPES = new Set(["AUDIO", "DEMO", "LIVE_RECORDING"]);
export const KIND_LABEL = { full: "Full track", demo: "Demo" };

/** The edition's protected, playable holder experiences: full track first, then demos. */
export function holderAudioOptions(experiences = []) {
  return experiences
    .filter((experience) => experience?.media?.protected && AUDIO_TYPES.has(String(experience.media.type || "").toUpperCase()))
    .map((experience) => ({ experience, kind: String(experience.media.type).toUpperCase() === "DEMO" ? "demo" : "full" }))
    .sort((a, b) => (a.kind === b.kind ? Number(b.experience.primary === true) - Number(a.experience.primary === true) : a.kind === "full" ? -1 : 1));
}

/** The player track for one holder experience. Its source is only ever the gateway grant for that experience. */
export function holderTrackFor(token, experience, kind) {
  if (!token) return null;
  const base = playableTrackFor(token, { protectedExperience: experience })
    || { n: String(token.tokenId), tokenId: token.tokenId, releaseToken: true, title: token.metadata?.name || token.name || "Track", art: ipfsToHttp(token.metadata?.image || "") || "", protectedMedia: { experienceId: experience.id, mediaType: experience.media.type || "AUDIO" } };
  // Never fall back to the public preview from a holder selection: no preview source on this track.
  return { ...base, src: "", previewSrc: "", preview: false, protectedTitle: experience.title, sourceKind: kind };
}
