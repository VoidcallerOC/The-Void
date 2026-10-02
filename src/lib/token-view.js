import { ipfsToHttp } from "./web3.js";

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
