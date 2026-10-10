// Stored 0 is an open edition. Null means the supply was never sent, so a
// limited draft keeps its form default instead of becoming open.
export function quantityFromSupply(supply) {
  if (supply == null || supply === "") return undefined;
  return String(supply);
}

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

// The release contract a release's own catalog editions were created on. The
// server creates every edition of a Factory-bound release on its bound clone,
// so after a reload this is the persisted binding even before any provisioning
// status has been read in this session.
export function boundReleaseContract(catalog, releaseId, chainId) {
  if (!releaseId) return "";
  const edition = (catalog?.editions || []).find((item) => item?.releaseId === releaseId && (item.releaseContractAddress || item.contractAddress) && (chainId == null || Number(item.chainId) === Number(chainId)));
  return edition ? edition.releaseContractAddress || edition.contractAddress : "";
}

// Resume an artist's OWN release (from GET /studio/catalog) for publishing.
// Unlike selectReleaseTemplate, it keeps the release and edition ids, so
// publishing updates that release instead of creating a new, empty one, and it
// restores the saved preview clip. Prefers the edition already carrying the
// gated full track, then the newest edition. Returns { published: true } for a
// release that is already on Fuji.
export function resumeOwnedRelease(catalog, releaseId) {
  const release = (catalog?.releases || []).find((item) => item.id === releaseId);
  if (!release) return null;
  const editions = (catalog?.editions || []).filter((edition) => edition.releaseId === releaseId);
  // A release already on Fuji cannot be published again: its token id is fixed
  // by the release and track slugs, so a second edition would collide with it.
  if (release.status === "published" || editions.some((edition) => edition.status === "available")) {
    const edition = editions.find((item) => item.status === "available" && item.tokenIds?.length) || editions.find((item) => item.tokenIds?.length) || null;
    return {
      published: true,
      releaseId: release.id,
      editionId: edition?.id || "",
      tokenId: edition?.tokenIds?.[0] == null ? "" : String(edition.tokenIds[0]),
      title: release.title || "",
      form: {
        releaseTitle: release.title || "",
        releaseType: release.releaseType === "ALBUM" ? "ALBUM" : "EP",
        releaseDescription: release.description || "",
        quantity: quantityFromSupply(edition?.supply) ?? "",
        priceWei: edition?.priceWei ? String(edition.priceWei) : undefined,
      },
    };
  }
  // The API lists editions newest first.
  const edition = editions.find((item) => editionHasGatedTrack(catalog, item.id)) || editions[0] || null;
  const includes = Array.isArray(edition?.includes) && edition.includes.length ? edition.includes.join("\n") : null;
  return {
    artistId: release.artistId || "",
    releaseId: release.id,
    editionId: edition?.id || "",
    gated: editionHasGatedTrack(catalog, edition?.id),
    form: {
      releaseTitle: release.title || "",
      releaseType: release.releaseType === "ALBUM" ? "ALBUM" : "EP",
      releaseDescription: release.description || "",
      releaseArtwork: release.artwork && !release.artwork.startsWith("/assets/") ? release.artwork : "",
      trackTitle: edition?.title || release.title || "",
      trackPreview: edition?.previewAudio || "",
      ...(quantityFromSupply(edition?.supply) === undefined ? {} : { quantity: quantityFromSupply(edition.supply) }),
      ...(includes ? { includes } : {}),
    },
  };
}
