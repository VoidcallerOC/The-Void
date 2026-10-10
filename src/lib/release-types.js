// Studio release types, matching the server's releaseType(): a SINGLE is one standalone
// track on its own release contract, an EP is a multi-track release, and an ALBUM uses the
// Album Contract. Releases saved before types existed have none and stay EP.
export const RELEASE_TYPES = Object.freeze(["SINGLE", "EP", "ALBUM"]);

export const RELEASE_TYPE_LABELS = Object.freeze({
  SINGLE: "Single · one standalone track on its own contract",
  EP: "EP / multi-track release",
  ALBUM: "Album Contract · up to 13 tracks / 4 singles",
});

export function releaseTypeOf(value) {
  const type = String(value ?? "").trim().toUpperCase();
  return RELEASE_TYPES.includes(type) ? type : "EP";
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
