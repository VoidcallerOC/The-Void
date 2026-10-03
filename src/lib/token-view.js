import { ipfsToHttp } from "./web3.js";
import { VC_DATA } from "../data.js";

// Each track is its own token. Views of one track resolve that token's own
// metadata first and only fall back to the edition / release (collection) art.

const DEFAULT_ARTWORK = "/assets/voidcaller_art_4.png";

function sameId(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

/** The catalog token a track view is about, or null. */
export function tokenFor(catalog, { edition = null, tokenId = null, experience = null } = {}) {
  const tokens = catalog?.tokens || [];
  if (experience) {
    const linked = tokens.find((token) => (token.experiences || []).includes(experience.id));
    if (linked) return linked;
    if (tokenId === null || tokenId === undefined) tokenId = experience.media?.tokenId ?? null;
  }
  if (!edition) return null;
  const inEdition = tokens.filter((token) => token.editionId === edition.id);
  if (tokenId !== null && tokenId !== undefined) return inEdition.find((token) => sameId(token.tokenId, tokenId)) || null;
  return inEdition.length === 1 ? inEdition[0] : null;
}

/**
 * Player title for an experience's own audio (e.g. a demo attached to a
 * token): the experience's name, not the token's song title.
 */
export function experienceTrackTitle({ experience = null, tokenTrack = null, view = null } = {}) {
  return experience?.title || tokenTrack?.title || view?.name || "";
}

/** Display data for one token: its own name and artwork, then the collection's. */
export function tokenView(catalog, { edition = null, release = null, tokenId = null, experience = null } = {}) {
  const token = tokenFor(catalog, { edition, tokenId, experience });
  const metadata = token?.metadata || {};
  const sources = [ipfsToHttp(metadata.image || ""), token?.media?.art, edition?.artwork, release?.artwork, DEFAULT_ARTWORK].filter(Boolean);
  return {
    token,
    tokenId: token?.tokenId ?? tokenId ?? null,
    name: metadata.name || token?.name || experience?.title || edition?.title || release?.title || "",
    description: metadata.description || "",
    artwork: sources[0],
    artworkSources: [...new Set(sources)],
  };
}

/**
 * The player track for one token, or null. Legacy Voidcaller tokens use their
 * catalog track (public preview, upgraded to the gated full track for
 * holders). Published tokens play their public preview (animation_url).
 */
export function playableTrackFor(token, { artwork = "" } = {}) {
  if (!token) return null;
  const legacy = token.editionId === "voidcaller-chapter-i" ? VC_DATA.firstEPTracks.find((track) => sameId(track.tokenId, token.tokenId)) : null;
  if (legacy) return legacy;
  const preview = ipfsToHttp(token.metadata?.animationUrl || token.media?.previewSrc || "");
  if (!preview) return null;
  return { n: String(token.tokenId), title: token.metadata?.name || token.name || "Track", previewSrc: preview, src: preview, preview: true, art: artwork || ipfsToHttp(token.metadata?.image || "") || token.media?.art || "" };
}
