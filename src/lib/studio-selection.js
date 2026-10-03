export function selectReleaseTemplate(record) {
  const release = record?.release || {};
  return {
    artistId: "",
    releaseId: "",
    editionId: "",
    selectedReleaseId: "",
    form: {
      releaseTitle: release.title || "",
      releaseDescription: release.description || "",
      releaseArtwork: release.artwork || "",
      trackArtwork: "",
    },
  };
}

/** True when an experience on this edition serves a private, token-gated track. */
export function editionHasGatedTrack(catalog, editionId) {
  if (!editionId) return false;
  return (catalog?.experiences || []).some((experience) => experience?.editionId === editionId && experience?.media?.protected === true);
}

// Resume an artist's OWN release (from GET /studio/catalog) for publishing.
// Unlike selectReleaseTemplate, it keeps the release and edition ids, so
// publishing updates that release instead of creating a new, empty one, and it
// restores the saved preview clip. Prefers the edition already carrying the
// gated full track, then the newest edition without an on-chain token.
export function resumeOwnedRelease(catalog, releaseId) {
  const release = (catalog?.releases || []).find((item) => item.id === releaseId);
  if (!release) return null;
  const editions = (catalog?.editions || []).filter((edition) => edition.releaseId === releaseId);
  const unpublished = editions.filter((edition) => edition.status !== "available");
  const edition = unpublished.find((item) => editionHasGatedTrack(catalog, item.id)) || unpublished[unpublished.length - 1] || null;
  const includes = Array.isArray(edition?.includes) && edition.includes.length ? edition.includes.join("\n") : null;
  return {
    artistId: release.artistId || "",
    releaseId: release.id,
    editionId: edition?.id || "",
    gated: editionHasGatedTrack(catalog, edition?.id),
    form: {
      releaseTitle: release.title || "",
      releaseDescription: release.description || "",
      releaseArtwork: release.artwork && !release.artwork.startsWith("/assets/") ? release.artwork : "",
      trackTitle: edition?.title || release.title || "",
      trackPreview: edition?.previewAudio || "",
      ...(edition?.supply ? { quantity: String(edition.supply) } : {}),
      ...(includes ? { includes } : {}),
    },
  };
}
