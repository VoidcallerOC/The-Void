// A release is the catalog record. Each edition on that release is one distinct
// track and, once published, one token. Mint quantity is copies of a token
// that already exists. It is never how a new song gets onto the release.
export function tracksOnRelease(release, editions = []) {
  if (!release) return [];
  const onRelease = (editions || []).filter((edition) => edition?.releaseId === release.id);
  if (onRelease.length) {
    return onRelease.map((edition) => ({
      id: edition.id,
      editionId: edition.id,
      title: edition.title || "Untitled track",
      tokenId: edition.tokenIds?.[0] === undefined || edition.tokenIds?.[0] === null || edition.tokenIds?.[0] === "" ? "" : String(edition.tokenIds[0]),
      experienceId: edition.experienceIds?.[0] || "",
    }));
  }
  return Array.isArray(release.tracks) ? release.tracks : [];
}
