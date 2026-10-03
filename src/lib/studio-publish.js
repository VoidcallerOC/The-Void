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
  const rawSupply = String(supply ?? "").trim();
  // Blank or 0 is an open edition. The sale end time, not this field, closes it.
  const quantity = rawSupply === "" || /^0+$/.test(rawSupply) ? "0" : rawSupply;
  if (!/^\d+$/.test(quantity)) throw new Error("Supply must be a positive whole number, or blank or 0 for an unlimited edition.");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Release metadata is required.");
  requiredText(metadata.artwork, "Release artwork");
  return { title, tracks, supply: quantity, metadata };
}

/** The Studio may advance only when the catalog is published and provenance
 * was independently verified. Pending and failed anchors are not success. */
export function publicationResultMessage({ title, provenanceStatus, fullyPublished }) {
  const name = String(title || "This release").trim();
  if (fullyPublished === true && provenanceStatus === "PROVENANCE_VERIFIED") {
    return { fullyPublished: true, message: `Published ${name}. Provenance verified. This does not establish legal copyright ownership.` };
  }
  if (provenanceStatus === "PROVENANCE_FAILED") {
    return { fullyPublished: false, message: `${name} is not fully published. Provenance verification failed and can be retried.` };
  }
  return { fullyPublished: false, message: `${name} is not fully published. Provenance verification is still pending.` };
}

/** The publish step must call the existing release routes with the id returned
 * by the save, not a stale empty state value. An empty id collapses
 * `/studio/releases//metadata` and the API answers "Route not found." */
export function studioPublicationPath(releaseId, suffix) {
  const id = String(releaseId ?? "").trim();
  if (!id) throw new Error("Save the release before publishing.");
  return `/studio/releases/${encodeURIComponent(id)}/${suffix}`;
}

export function transactionEvidenceFromError(error, fallbackExplorerUrl = null) {
  if (!error?.transactionHash) return null;
  return {
    transactionHash: error.transactionHash,
    explorerUrl: error.explorerUrl || fallbackExplorerUrl || null,
    contractAddress: error.contractAddress,
    chainId: error.chainId,
    code: error.code,
  };
}

/** Current-operation evidence is replaced by the latest failure and cleared
 * by any successful transaction. Historical records remain backend data. */
export function transactionEvidenceForOutcome({ status, error = null, evidence = null, fallbackExplorerUrl = null } = {}) {
  if (status === "success") return null;
  if (status === "failure") return evidence || transactionEvidenceFromError(error, fallbackExplorerUrl);
  return null;
}
