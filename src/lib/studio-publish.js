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

