function requiredText(value, field) {
  if (!String(value ?? "").trim()) throw new Error(`${field} is required.`);
  return String(value).trim();
}

export function validateReleasePublish({ release, tracks, supply, metadata } = {}) {
  const title = requiredText(release?.title, "Release title");
  requiredText(release?.type, "Release type");
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error("At least one track is required.");
  tracks.forEach((track, index) => {
    requiredText(track?.title, `Track ${index + 1} title`);
  });
  const quantity = requiredText(supply, "Supply");
  try {
    if (BigInt(quantity) <= 0n) throw new Error();
  } catch {
    throw new Error("Supply must be a positive whole number.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Release metadata is required.");
  requiredText(metadata.artwork, "Release artwork");
  return { title, tracks, supply: quantity, metadata };
}

/** The publish step must call the existing release routes with the id returned
 * by the save, not a stale empty state value. An empty id collapses
 * `/studio/releases//metadata` and the API answers "Route not found." */
export function studioPublicationPath(releaseId, suffix) {
  const id = String(releaseId ?? "").trim();
  if (!id) throw new Error("Save the release before publishing.");
  return `/studio/releases/${encodeURIComponent(id)}/${suffix}`;
}
