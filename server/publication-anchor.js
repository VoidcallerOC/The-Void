import { Buffer } from "node:buffer";
import { ApiError } from "./api-errors.js";
import { digestCanonicalMetadata } from "./metadata-storage.js";
import { canonicalProvenanceManifest, sha256Bytes } from "./provenance-manifest.js";

/** Cheapest anchor: the existing Fuji `createEdition` transaction.
 *
 * Acyclic commitment, and only this direction:
 * asset bytes → SHA-256 → provenance manifest (includes metadata digest)
 * → provenance root → metadata document (`_void` + `provenance` added after the digest)
 * → IPFS CID → `EditionCreated.metadataUri` and `edition().metadataUri`.
 *
 * The canonical metadata hash excludes `_void` and `provenance`. The root is
 * therefore not an input to the digest that the root commits. The CID commits
 * the document. The edition transaction commits the CID and cannot be rewritten
 * (`metadataUri` is immutable on the certified contract). No second transaction
 * is required.
 *
 * `createdAt` inside the manifest is an operational stamp. The anchor time is
 * the edition transaction's block timestamp. Neither is legal copyright. */

const ENVELOPE = new Set(["_void", "provenance"]);

export function ipfsPath(metadataUri) {
  const path = String(metadataUri || "").trim().replace(/^ipfs:\/\//, "");
  if (!path || path.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new ApiError(400, "METADATA_URI_INVALID", "The publication metadata URI is not a content identifier.");
  }
  return path;
}

export function canonicalBody(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ApiError(409, "PROVENANCE_INCONSISTENT", "Published metadata is not a canonical document.");
  }
  return Object.fromEntries(Object.entries(document).filter(([key]) => !ENVELOPE.has(key)));
}

export function derivePublicationProvenance(document) {
  const digest = digestCanonicalMetadata(canonicalBody(document));
  const provenance = document?.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new ApiError(409, "PROVENANCE_INCONSISTENT", "The published metadata does not contain a provenance manifest.");
  }
  if (provenance.metadataDigest !== digest.digest || document?._void?.digest !== digest.digest) {
    throw new ApiError(409, "PROVENANCE_INCONSISTENT", "The metadata digest does not match the canonical metadata bytes.");
  }
  const assets = Array.isArray(provenance.assets) ? provenance.assets : [];
  const rebuilt = canonicalProvenanceManifest({
    releaseId: provenance.releaseId,
    editionId: provenance.editionId,
    creator: provenance.creator,
    metadataDigest: digest.digest,
    createdAt: provenance.createdAt,
    artwork: assets.find((asset) => asset?.role === "artwork") || null,
    audio: assets.find((asset) => asset?.role === "audio") || null,
    protectedMedia: assets.filter((asset) => asset?.role === "protected-media"),
  });
  if (rebuilt.root !== provenance.root) {
    throw new ApiError(409, "PROVENANCE_INCONSISTENT", "The provenance root does not match the committed manifest.");
  }
  return {
    metadataDigest: digest.digest,
    provenanceRoot: rebuilt.root,
    operationalCreatedAt: rebuilt.manifest.createdAt,
    creatorWallet: rebuilt.manifest.creator.wallet,
    releaseId: rebuilt.manifest.releaseId,
    editionId: rebuilt.manifest.editionId,
    assets: rebuilt.manifest.assets,
    copyrightOwnership: false,
    artistVerification: "NOT_ASSERTED",
  };
}

export function metadataBytes(document) {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return { bytes, sha256: sha256Bytes(bytes) };
}

export function readCidDocument(metadataUri, bytes) {
  const path = ipfsPath(metadataUri);
  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ApiError(409, "PROVENANCE_INCONSISTENT", "The metadata CID did not resolve to canonical JSON.");
  }
  return { cid: path.split("/")[0], metadataByteSha256: sha256Bytes(bytes), document };
}

export function assertAssetHash(document, { role, sha256 }) {
  const expected = String(sha256 || "").toLowerCase();
  const asset = (document?.provenance?.assets || []).find((entry) => entry?.role === role);
  if (!asset || asset.sha256 !== expected) {
    throw new ApiError(409, "PROVENANCE_ASSET_MISMATCH", "A committed asset hash does not match the exact file bytes.");
  }
  return asset;
}

/** Independent check of one existing edition publication. Nothing here is
 * inferred from a successful transaction alone. */
export function verifyEditionPublication({ metadataUri, bytes, receipt, event, onChainUri, blockTimestamp, releaseId, editionId }) {
  if (!receipt) throw new ApiError(409, "PUBLICATION_NOT_CONFIRMED", "The publication transaction was not found.");
  if (receipt.status !== 1) throw new ApiError(409, "PUBLICATION_NOT_CONFIRMED", "The publication transaction failed.");
  if (!event || event.name !== "EditionCreated" || event.args?.metadataUri !== metadataUri || onChainUri !== metadataUri) {
    throw new ApiError(409, "PUBLICATION_NOT_CONFIRMED", "The edition event does not commit this metadata CID.");
  }
  if (blockTimestamp == null || Number.isNaN(new Date(blockTimestamp).getTime())) {
    throw new ApiError(409, "ANCHOR_BLOCK_UNAVAILABLE", "The publication block timestamp is required. A server timestamp is not an anchor.");
  }
  const loaded = readCidDocument(metadataUri, bytes);
  const derived = derivePublicationProvenance(loaded.document);
  if (derived.releaseId !== releaseId || derived.editionId !== editionId) {
    throw new ApiError(409, "PROVENANCE_INCONSISTENT", "The committed provenance describes a different release edition.");
  }
  return {
    mechanism: "edition-metadata-cid",
    ...derived,
    metadataCid: loaded.cid,
    metadataByteSha256: loaded.metadataByteSha256,
    transactionHash: receipt.transactionHash || null,
    blockNumber: receipt.blockNumber ?? null,
    anchorBlockTimestamp: new Date(blockTimestamp).toISOString(),
    anchorEvent: "EditionCreated",
    copyrightOwnership: false,
  };
}

export function createIpfsMetadataFetcher({ gateway = "https://gateway.pinata.cloud/ipfs", fetchImpl = fetch } = {}) {
  const base = String(gateway || "").replace(/\/$/, "");
  return async function fetchMetadata(metadataUri) {
    const path = ipfsPath(metadataUri);
    const response = await fetchImpl(`${base}/${path}`);
    if (!response.ok) throw new ApiError(503, "METADATA_CID_UNAVAILABLE", "The publication metadata CID could not be retrieved.");
    return Buffer.from(await response.arrayBuffer());
  };
}
