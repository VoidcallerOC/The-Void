// Studio release types, matching the server's releaseType(): a SINGLE is one standalone
// track on its own release contract, an EP is a multi-track release, and an ALBUM uses the
// Album Contract. Releases saved before types existed have none and stay EP.
export const RELEASE_TYPES = Object.freeze(["SINGLE", "EP", "ALBUM"]);

// Hard cap on tracks in an EP. The server enforces it on every create/update/submit path; the
// Studio only mirrors it. An existing draft above the cap stays editable so tracks can be removed.
export const MAX_EP_TRACKS = 5;

export const RELEASE_TYPE_LABELS = Object.freeze({
  SINGLE: "Single · one standalone track on its own contract",
  EP: `EP / multi-track release · up to ${MAX_EP_TRACKS} tracks`,
  // D2 Option A: 13 / 4 are the contract's defaults. The release admin (the artist) can approve
  // higher limits on-chain with approveExpandedRelease until the album is closed.
  ALBUM: "Album Contract · 13 tracks / 4 singles by default",
});

export const EP_TRACK_LIMIT_MESSAGE = `An EP holds at most ${MAX_EP_TRACKS} tracks. Remove a track, or create an Album Contract for a longer record.`;

export function releaseTypeOf(value) {
  const type = String(value ?? "").trim().toUpperCase();
  return RELEASE_TYPES.includes(type) ? type : "EP";
}

// Studio view of the EP cap: `atLimit` blocks adding another track; `overLimit` is a draft created
// before the cap, which stays editable so the artist can remove tracks (nothing is deleted for them).
export function epTrackLimit(type, trackCount) {
  const count = Math.max(0, Number(trackCount) || 0);
  const limited = releaseTypeOf(type) === "EP";
  return { limited, max: MAX_EP_TRACKS, count, atLimit: limited && count >= MAX_EP_TRACKS, overLimit: limited && count > MAX_EP_TRACKS };
}

const asArray = (value) => (Array.isArray(value) ? value : []);

// A published edition maps to "available" in the Studio catalog.
export function releaseHasPublishedEdition(catalog, releaseId) {
  return asArray(catalog?.editions).some((edition) => edition?.releaseId === releaseId && edition.status === "available");
}

// A SINGLE takes exactly one published track; the server refuses a second one.
export function singleIsComplete(catalog, release) {
  return releaseTypeOf(release?.releaseType) === "SINGLE" && (release?.status === "published" || releaseHasPublishedEdition(catalog, release?.id));
}

// Singles already listed on an album, in track order, with their titles.
export function linkedAlbumSingles(catalog, albumReleaseId) {
  const releases = new Map(asArray(catalog?.releases).map((release) => [release.id, release]));
  return asArray(catalog?.albumSingles)
    .filter((link) => (link.album_release_id ?? link.albumReleaseId) === albumReleaseId)
    .map((link) => {
      const singleReleaseId = link.single_release_id ?? link.singleReleaseId;
      return { singleReleaseId, trackPosition: Number(link.track_position ?? link.trackPosition), title: releases.get(singleReleaseId)?.title || singleReleaseId };
    })
    .sort((a, b) => a.trackPosition - b.trackPosition);
}

// The artist's own published singles that are not on this album yet.
export function albumSingleCandidates(catalog, albumRelease) {
  if (!albumRelease) return [];
  const linked = new Set(linkedAlbumSingles(catalog, albumRelease.id).map((link) => link.singleReleaseId));
  return asArray(catalog?.releases).filter((release) => release.id !== albumRelease.id
    && release.artistId === albumRelease.artistId
    && releaseTypeOf(release.releaseType) === "SINGLE"
    && singleIsComplete(catalog, release)
    && !linked.has(release.id));
}

// The first free track position on the album, for the form default.
export function nextAlbumTrackPosition(catalog, albumReleaseId) {
  const taken = new Set(linkedAlbumSingles(catalog, albumReleaseId).map((link) => link.trackPosition));
  let position = 1;
  while (taken.has(position)) position += 1;
  return position;
}
