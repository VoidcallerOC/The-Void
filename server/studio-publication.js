import { ApiError } from "./api-errors.js";

/** Publication-facing provenance states. These are derived from the proof row.
 * SUBMITTED is still pending. VERIFIED requires an anchored, independently
 * confirmed proof. A catalog PUBLISHED release is not fully published until then. */
export const PROVENANCE_PUBLICATION = Object.freeze({
  PENDING: "PROVENANCE_PENDING",
  FAILED: "PROVENANCE_FAILED",
  VERIFIED: "PROVENANCE_VERIFIED",
});

export function provenancePublicationStatus(proof) {
  if (proof?.verification_status === "VERIFIED" && proof?.anchor_status === "ANCHORED") return PROVENANCE_PUBLICATION.VERIFIED;
  if (proof?.anchor_status === "FAILED" || proof?.anchor_status === "REORGED" || proof?.verification_status === "FAILED") return PROVENANCE_PUBLICATION.FAILED;
  return PROVENANCE_PUBLICATION.PENDING;
}

export function publicationView({ releaseStatus = "DRAFT", proof = null } = {}) {
  const provenanceStatus = provenancePublicationStatus(proof);
  const catalogPublished = releaseStatus === "PUBLISHED";
  return {
    status: catalogPublished ? "PUBLISHED" : releaseStatus,
    provenanceStatus,
    fullyPublished: catalogPublished && provenanceStatus === PROVENANCE_PUBLICATION.VERIFIED,
  };
}

export function assertProvenanceConsistency({ releaseId, editionId, metadata, provenanceRoot }) {
  const provenance = metadata?.provenance;
  const digest = metadata?._void?.digest;
  const root = provenance?.root;
  if (!provenance || !digest || provenance.metadataDigest !== digest || !root || root !== provenanceRoot || provenance.releaseId !== releaseId || provenance.editionId !== editionId) {
    throw new ApiError(409, "PROVENANCE_INCONSISTENT", "Metadata and provenance do not describe the same release edition. The release was not marked fully published.");
  }
  return provenance;
}

export async function persistPublicationProof(records, { release, edition, wallet, provenance }) {
  const existing = await records.findOwnedByRoot({ releaseId: release.id, editionId: edition.id, manifestSha256: provenance.root, creatorWallet: wallet });
  if (existing) return existing;
  const assets = provenance.record?.assets || [];
  const single = (role) => {
    const matches = assets.filter((asset) => asset?.role === role);
    return matches.length === 1 ? matches[0].sha256 : null;
  };
  const protectedAssets = assets.filter((asset) => asset?.role === "protected-media");
  try {
    return await records.createProof({
      releaseId: release.id,
      editionId: edition.id,
      creatorWallet: wallet,
      metadataSha256: provenance.metadataDigest,
      artworkSha256: single("artwork"),
      audioSha256: single("audio"),
      experienceSha256: protectedAssets.length === 1 ? protectedAssets[0].sha256 : null,
      manifestSha256: provenance.root,
      schemaVersion: provenance.record.schemaVersion,
      proofTimestamp: provenance.record.createdAt,
    });
  } catch (error) {
    if (error?.code !== "PROVENANCE_ALREADY_RECORDED") throw error;
    const again = await records.findOwnedByRoot({ releaseId: release.id, editionId: edition.id, manifestSha256: provenance.root, creatorWallet: wallet });
    if (!again) throw error;
    return again;
  }
}
