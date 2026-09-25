import { ethers } from "ethers";
import process from "node:process";
import { ApiError } from "./api-errors.js";
import { requireWalletAuth } from "./api-runtime.js";
import { ConfigurationError } from "./config.js";
import fujiRelease from "../config/fuji-release.json" with { type: "json" };
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { ProvenanceRecords } from "./provenance-records.js";
import { publicationView } from "./studio-publication.js";

const FUJI_RELEASE = fujiRelease.contractAddress.toLowerCase();
const EVENT_NAME = "ProvenanceAnchored";
export const ANCHOR_ABI = Object.freeze([
  "function anchor(bytes32 releaseId, bytes32 editionId, bytes32 provenanceRoot)",
  "function isAnchored(bytes32 releaseId, bytes32 editionId, bytes32 provenanceRoot) view returns (bool)",
  "event ProvenanceAnchored(bytes32 indexed provenanceRoot, bytes32 indexed releaseId, bytes32 indexed editionId, uint256 tokenId, address artist, address releaseContract)",
]);
const iface = new ethers.Interface(ANCHOR_ABI);

function editionSlug(value) {
  const slug = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/g, "");
  if (!slug) throw new ApiError(400, "TITLE_REQUIRED", "The edition title is required before anchoring.");
  return slug;
}

function bytes32Slug(value, field) {
  const slug = String(value || "").trim();
  if (!slug || slug.length > 31) throw new ApiError(400, "ANCHOR_IDENTITY_INVALID", `${field} must be non-empty and at most 31 bytes.`);
  return ethers.encodeBytes32String(slug);
}

export function provenanceRootBytes(hex) {
  const hash = String(hex || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, "PROVENANCE_HASH_INVALID", "The provenance root must be a SHA-256 digest.");
  return `0x${hash}`;
}

export function tokenIdFor(releaseSlug, editionTitleSlug) {
  const releaseId = bytes32Slug(releaseSlug, "release.slug");
  const editionId = bytes32Slug(editionTitleSlug, "edition.slug");
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", releaseId, editionId]));
  const tokenId = BigInt(digest);
  return { releaseId, editionId, tokenId: tokenId === 0n ? 1n : tokenId };
}

export function encodeAnchorCall({ releaseSlug, editionTitleSlug, provenanceRoot }) {
  const ids = tokenIdFor(releaseSlug, editionTitleSlug);
  const root = provenanceRootBytes(provenanceRoot);
  return { ...ids, provenanceRoot: root, data: iface.encodeFunctionData("anchor", [ids.releaseId, ids.editionId, root]) };
}

export function loadProvenanceAnchorConfig(env = process.env) {
  const appEnvironment = String(env.NODE_ENV || "development").trim().toLowerCase();
  const chainId = Number(env.PROVENANCE_ANCHOR_CHAIN_ID || 43113);
  if (!Number.isSafeInteger(chainId) || ![43113, 43114].includes(chainId)) {
    throw new ConfigurationError("PROVENANCE_ANCHOR_CHAIN_ID may contain only Avalanche Fuji (43113) or C-Chain (43114).");
  }
  if (appEnvironment === "production" && chainId !== 43113) {
    throw new ConfigurationError("Production provenance anchoring requires Avalanche Fuji (43113), separate from C-Chain reads.");
  }
  const network = String(env.PROVENANCE_ANCHOR_NETWORK || (chainId === 43113 ? "fuji" : "")).trim().toLowerCase();
  if (chainId === 43113 && network !== "fuji") throw new ConfigurationError("Fuji anchoring must use the fuji network name.");
  if (chainId === 43114 && network !== "avalanche") throw new ConfigurationError("C-Chain anchoring must use the avalanche network name.");
  const releaseContract = chainId === 43113
    ? FUJI_RELEASE
    : String(env.PROVENANCE_RELEASE_CONTRACT || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(releaseContract)) throw new ConfigurationError("The release contract for this network is not configured.");
  if (chainId !== 43113 && releaseContract === FUJI_RELEASE) {
    throw new ConfigurationError("The certified Fuji release contract cannot be used on another network.");
  }
  const address = String(env.PROVENANCE_ANCHOR_ADDRESS || "").trim().toLowerCase();
  const rpcUrl = String(env.PROVENANCE_ANCHOR_RPC_URL || "").trim();
  if (!address && !rpcUrl) {
    return Object.freeze({ enabled: false, chainId, network, releaseContract, eventName: EVENT_NAME });
  }
  if (!address || !rpcUrl || !/^0x[0-9a-f]{40}$/.test(address)) {
    throw new ConfigurationError("PROVENANCE_ANCHOR_ADDRESS and PROVENANCE_ANCHOR_RPC_URL must be set together.");
  }
  if (address === releaseContract || address === FUJI_RELEASE) {
    throw new ConfigurationError("The provenance anchor contract must not be the release contract.");
  }
  let parsed;
  try { parsed = new URL(rpcUrl); } catch { throw new ConfigurationError("PROVENANCE_ANCHOR_RPC_URL must be an absolute URL."); }
  if (appEnvironment === "production" && parsed.protocol !== "https:") {
    throw new ConfigurationError("Production provenance anchoring requires an HTTPS RPC URL.");
  }
  if (parsed.username || parsed.password) throw new ConfigurationError("PROVENANCE_ANCHOR_RPC_URL must not embed credentials.");
  return Object.freeze({
    enabled: true,
    chainId,
    network,
    releaseContract,
    contractAddress: address,
    rpcUrl: parsed.toString(),
    eventName: EVENT_NAME,
  });
}

function receiptSucceeded(status) {
  if (status === 1 || status === 1n || status === "0x1" || status === "1") return true;
  if (status === 0 || status === 0n || status === "0x0" || status === "0") return false;
  return null;
}

async function readChain(reader, method, args) {
  try {
    return await reader[method](...args);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "ANCHOR_RPC_UNAVAILABLE", "The anchor could not be read from the chain. It was not marked verified.");
  }
}

export async function inspectAnchorTransaction({ reader, config, expected }) {
  if (!config?.enabled) throw new ApiError(503, "PROVENANCE_ANCHOR_NOT_CONFIGURED", "Provenance anchoring is not configured for this deployment.");
  const network = await readChain(reader, "getNetwork", []);
  if (Number(network?.chainId) !== config.chainId) {
    throw new ApiError(409, "ANCHOR_CHAIN_MISMATCH", "The RPC chain does not match the configured anchor network. The proof was not verified.");
  }
  const transaction = await readChain(reader, "getTransaction", [expected.transactionHash]);
  if (!transaction) throw new ApiError(409, "ANCHOR_TRANSACTION_NOT_FOUND", "The anchor transaction was not found. The proof was not verified.");
  const target = String(transaction.to || "").toLowerCase();
  if (target !== config.contractAddress) throw new ApiError(409, "ANCHOR_TARGET_MISMATCH", "The transaction was not sent to the configured anchor contract.");
  if (String(transaction.from || "").toLowerCase() !== expected.wallet) {
    throw new ApiError(409, "ANCHOR_SIGNER_MISMATCH", "The anchor transaction was not sent by the edition artist.");
  }
  const expectedCall = encodeAnchorCall(expected);
  if (String(transaction.data || "").toLowerCase() !== expectedCall.data.toLowerCase()) {
    throw new ApiError(409, "ANCHOR_CALL_MISMATCH", "The transaction does not anchor this provenance root.");
  }
  const receipt = await readChain(reader, "getTransactionReceipt", [expected.transactionHash]);
  if (!receipt) return { outcome: "pending", call: expectedCall };
  const succeeded = receiptSucceeded(receipt.status);
  if (succeeded === null) throw new ApiError(409, "ANCHOR_NOT_CONFIRMED", "The anchor receipt could not be verified.");
  if (!succeeded) return { outcome: "failed", call: expectedCall };
  const event = (receipt.logs || []).filter((log) => String(log.address || "").toLowerCase() === config.contractAddress).map((log) => {
    try { return iface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === EVENT_NAME
    && parsed.args.provenanceRoot.toLowerCase() === expectedCall.provenanceRoot.toLowerCase()
    && parsed.args.releaseId === expectedCall.releaseId
    && parsed.args.editionId === expectedCall.editionId
    && parsed.args.tokenId === expectedCall.tokenId
    && String(parsed.args.artist).toLowerCase() === expected.wallet
    && String(parsed.args.releaseContract).toLowerCase() === config.releaseContract);
  if (!event) throw new ApiError(409, "ANCHOR_EVENT_MISMATCH", "The receipt did not contain the expected ProvenanceAnchored event. The proof was not verified.");
  const block = await readChain(reader, "getBlock", [receipt.blockNumber]);
  const timestamp = Number(block?.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new ApiError(409, "ANCHOR_NOT_CONFIRMED", "The anchor block timestamp could not be verified.");
  const anchored = await readChain(reader, "isAnchored", [{ releaseId: expectedCall.releaseId, editionId: expectedCall.editionId, provenanceRoot: expectedCall.provenanceRoot }]);
  if (anchored !== true) throw new ApiError(409, "ANCHOR_STATE_MISMATCH", "The anchor contract does not record this provenance root. The proof was not verified.");
  return {
    outcome: "verified",
    call: expectedCall,
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: new Date(timestamp * 1000).toISOString(),
    contractAddress: config.contractAddress,
    eventName: EVENT_NAME,
  };
}

function publicationFields(context, proof) {
  const view = publicationView({ releaseStatus: context?.release_status, proof });
  return { provenanceStatus: view.provenanceStatus, fullyPublished: view.fullyPublished, status: view.status };
}

const VERIFICATION_FAILURES = new Set(["ANCHOR_EVENT_MISMATCH", "ANCHOR_STATE_MISMATCH", "ANCHOR_CALL_MISMATCH", "ANCHOR_TARGET_MISMATCH", "ANCHOR_SIGNER_MISMATCH", "ANCHOR_NOT_CONFIRMED"]);

function assetHash(record, role) {
  const matches = (record.assets || []).filter((asset) => asset?.role === role);
  return matches.length === 1 ? matches[0].sha256 : null;
}

function rebuiltRoot(record, releaseId, editionId) {
  if (!record || record.releaseId !== releaseId || record.editionId !== editionId) {
    throw new ApiError(409, "ANCHOR_ROOT_MISMATCH", "The stored provenance manifest does not belong to this release edition.");
  }
  const rebuilt = canonicalProvenanceManifest({
    releaseId,
    editionId,
    creator: record.creator,
    metadataDigest: record.metadataDigest,
    createdAt: record.createdAt,
    artwork: (record.assets || []).find((asset) => asset?.role === "artwork") || null,
    audio: (record.assets || []).find((asset) => asset?.role === "audio") || null,
    protectedMedia: (record.assets || []).filter((asset) => asset?.role === "protected-media"),
  });
  if (rebuilt.root !== String(record.root || "").toLowerCase()) {
    throw new ApiError(409, "ANCHOR_ROOT_MISMATCH", "The stored provenance root does not match the canonical manifest.");
  }
  return { record, root: rebuilt.root, metadataDigest: rebuilt.metadataDigest };
}

/** Confirms a provenance root on the existing Fuji release identity. Does not publish the edition. */
export class ProvenanceAnchorService {
  constructor({ db, records = null, authenticator, config, reader = null } = {}) {
    if (!db?.query) throw new TypeError("ProvenanceAnchorService requires a database executor.");
    this.db = db;
    this.records = records || new ProvenanceRecords({ db });
    this.authenticator = authenticator;
    this.config = config;
    this.reader = reader;
  }

  chainReader() {
    if (this.reader) return this.reader;
    if (!this.config?.enabled) throw new ApiError(503, "PROVENANCE_ANCHOR_NOT_CONFIGURED", "Provenance anchoring is not configured for this deployment.");
    const provider = new ethers.JsonRpcProvider(this.config.rpcUrl, this.config.chainId);
    const view = new ethers.Interface(ANCHOR_ABI);
    return {
      getNetwork: () => provider.getNetwork(),
      getTransaction: (hash) => provider.getTransaction(hash),
      getTransactionReceipt: (hash) => provider.getTransactionReceipt(hash),
      getBlock: (number) => provider.getBlock(number),
      isAnchored: async ({ releaseId, editionId, provenanceRoot }) => {
        const data = view.encodeFunctionData("isAnchored", [releaseId, editionId, provenanceRoot]);
        const result = await provider.call({ to: this.config.contractAddress, data });
        return Boolean(view.decodeFunctionResult("isAnchored", result)[0]);
      },
    };
  }

  async editionContext(releaseId, wallet) {
    const { rows } = await this.db.query(
      `SELECT r.id AS release_id, r.slug AS release_slug, r.status AS release_status, r.artist_id, e.id AS edition_id, e.title,
              t.token_id, t.metadata, t.metadata_version
       FROM releases r
       JOIN artist_owners ao ON ao.artist_id = r.artist_id AND ao.owner_wallet = $2
       JOIN editions e ON e.release_id = r.id
       LEFT JOIN tokens t ON t.edition_id = e.id
       WHERE r.id = $1
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [releaseId, wallet],
    );
    const row = rows[0];
    if (!row) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot anchor this release.");
    if (!row.edition_id) throw new ApiError(400, "EDITION_REQUIRED", "Create an edition before anchoring provenance.");
    const provenance = row.metadata?.provenance;
    if (!provenance?.root) throw new ApiError(409, "PROVENANCE_ROOT_REQUIRED", "Publish the canonical provenance manifest before anchoring it.");
    const rebuilt = rebuiltRoot(provenance, row.release_id, row.edition_id);
    const slug = editionSlug(row.title);
    const ids = tokenIdFor(row.release_slug, slug);
    if (row.token_id != null && BigInt(row.token_id) !== ids.tokenId) {
      throw new ApiError(409, "ANCHOR_EDITION_IDENTITY", "The edition token id does not match the certified release identity.");
    }
    return { ...row, editionSlug: slug, ...ids, root: rebuilt.root, metadataDigest: rebuilt.metadataDigest, provenance };
  }

  async ensureProof(context, wallet) {
    const existing = await this.records.findOwnedByRoot({ releaseId: context.release_id, editionId: context.edition_id, manifestSha256: context.root, creatorWallet: wallet });
    if (existing) return existing;
    const protectedAssets = (context.provenance.assets || []).filter((asset) => asset?.role === "protected-media");
    return this.records.createProof({
      releaseId: context.release_id,
      editionId: context.edition_id,
      creatorWallet: wallet,
      metadataSha256: context.metadataDigest,
      artworkSha256: assetHash(context.provenance, "artwork"),
      audioSha256: assetHash(context.provenance, "audio"),
      experienceSha256: protectedAssets.length === 1 ? protectedAssets[0].sha256 : null,
      manifestSha256: context.root,
      schemaVersion: context.provenance.schemaVersion,
      proofTimestamp: context.provenance.createdAt,
    });
  }

  async prepare({ request, releaseId }) {
    if (!this.config?.enabled) throw new ApiError(503, "PROVENANCE_ANCHOR_NOT_CONFIGURED", "Provenance anchoring is not configured for this deployment.");
    const identity = await requireWalletAuth(this.authenticator, request);
    const context = await this.editionContext(String(releaseId || "").trim(), identity.wallet);
    const proof = await this.ensureProof(context, identity.wallet);
    if (proof.verification_status === "VERIFIED") {
      return { proofId: proof.id, provenanceRoot: context.root, chainId: this.config.chainId, network: this.config.network, anchorStatus: proof.anchor_status, verificationStatus: "VERIFIED", alreadyAnchored: true, data: null, ...publicationFields(context, proof) };
    }
    const call = encodeAnchorCall({ releaseSlug: context.release_slug, editionTitleSlug: context.editionSlug, provenanceRoot: context.root });
    return {
      proofId: proof.id,
      releaseId: context.release_id,
      editionId: context.edition_id,
      provenanceRoot: context.root,
      chainId: this.config.chainId,
      network: this.config.network,
      contractAddress: this.config.contractAddress,
      releaseContract: this.config.releaseContract,
      eventName: EVENT_NAME,
      tokenId: call.tokenId.toString(),
      data: call.data,
      anchorStatus: proof.anchor_status,
      verificationStatus: proof.verification_status,
      alreadyAnchored: false,
      ...publicationFields(context, proof),
      note: "This anchor commits the provenance root. It does not establish legal copyright ownership.",
    };
  }

  expected(context, wallet, transactionHash) {
    return { transactionHash, wallet, releaseSlug: context.release_slug, editionTitleSlug: context.editionSlug, provenanceRoot: context.root };
  }

  async openForAttempt(proof, wallet) {
    if (proof.verification_status === "VERIFIED" || proof.anchor_status === "ANCHORED") return proof;
    if (proof.anchor_status === "FAILED" || proof.anchor_status === "REORGED") {
      return this.records.retryProof({ id: proof.id, creatorWallet: wallet });
    }
    return proof;
  }

  async submit({ request, releaseId, input = {} }) {
    if (!this.config?.enabled) throw new ApiError(503, "PROVENANCE_ANCHOR_NOT_CONFIGURED", "Provenance anchoring is not configured for this deployment.");
    const identity = await requireWalletAuth(this.authenticator, request);
    const hash = String(input.transactionHash || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, "TRANSACTION_INVALID", "The anchor transaction hash is invalid.");
    const context = await this.editionContext(String(releaseId || "").trim(), identity.wallet);
    const proof = await this.openForAttempt(await this.ensureProof(context, identity.wallet), identity.wallet);
    if (proof.verification_status === "VERIFIED") throw new ApiError(409, "PROVENANCE_ALREADY_VERIFIED", "This provenance root is already verified.");
    const observed = await inspectAnchorTransaction({ reader: this.chainReader(), config: this.config, expected: this.expected(context, identity.wallet, hash) });
    if (observed.outcome === "failed") {
      const failed = await this.records.recordAnchorFailure({ id: proof.id, creatorWallet: identity.wallet, failureCode: "ANCHOR_TRANSACTION_REVERTED", failureDetail: "The anchor transaction reverted." });
      return { proofId: failed.id, provenanceRoot: context.root, anchorStatus: "FAILED", verificationStatus: "UNVERIFIED", transactionHash: hash, provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false };
    }
    const submitted = await this.records.recordSubmittedAnchor({
      id: proof.id,
      creatorWallet: identity.wallet,
      chainKey: this.config.network,
      chainId: this.config.chainId,
      transactionHash: hash,
      anchorContract: this.config.contractAddress,
      anchorEvent: EVENT_NAME,
    });
    return { proofId: submitted.id, provenanceRoot: context.root, anchorStatus: "SUBMITTED", verificationStatus: "UNVERIFIED", transactionHash: hash, pending: observed.outcome === "pending", ...publicationFields(context, { anchor_status: "SUBMITTED", verification_status: "UNVERIFIED" }) };
  }

  async confirm({ request, releaseId, input = {} }) {
    if (!this.config?.enabled) throw new ApiError(503, "PROVENANCE_ANCHOR_NOT_CONFIGURED", "Provenance anchoring is not configured for this deployment.");
    const identity = await requireWalletAuth(this.authenticator, request);
    const hash = String(input.transactionHash || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, "TRANSACTION_INVALID", "The anchor transaction hash is invalid.");
    const context = await this.editionContext(String(releaseId || "").trim(), identity.wallet);
    const existing = await this.ensureProof(context, identity.wallet);
    if (existing.verification_status === "VERIFIED") {
      if (String(existing.transaction_hash || "").toLowerCase() === hash) {
        return { proofId: existing.id, provenanceRoot: context.root, anchorStatus: "ANCHORED", verificationStatus: "VERIFIED", transactionHash: hash, ...publicationFields(context, existing) };
      }
      throw new ApiError(409, "PROVENANCE_ALREADY_VERIFIED", "This provenance root is already verified.");
    }
    const proof = await this.openForAttempt(existing, identity.wallet);
    let observed;
    try {
      observed = await inspectAnchorTransaction({ reader: this.chainReader(), config: this.config, expected: this.expected(context, identity.wallet, hash) });
    } catch (error) {
      if (VERIFICATION_FAILURES.has(error?.code)) {
        await this.records.recordAnchorFailure({ id: proof.id, creatorWallet: identity.wallet, failureCode: error.code, failureDetail: "The anchor transaction was not verified." }).catch(() => {});
      }
      throw error;
    }
    if (observed.outcome === "pending") {
      const pending = await this.records.recordSubmittedAnchor({
        id: proof.id, creatorWallet: identity.wallet, chainKey: this.config.network, chainId: this.config.chainId, transactionHash: hash, anchorContract: this.config.contractAddress, anchorEvent: EVENT_NAME,
      });
      return { proofId: pending.id, provenanceRoot: context.root, anchorStatus: "SUBMITTED", verificationStatus: "UNVERIFIED", transactionHash: hash, pending: true, ...publicationFields(context, { anchor_status: "SUBMITTED", verification_status: "UNVERIFIED" }) };
    }
    if (observed.outcome === "failed") {
      const failed = await this.records.recordAnchorFailure({ id: proof.id, creatorWallet: identity.wallet, failureCode: "ANCHOR_TRANSACTION_REVERTED", failureDetail: "The anchor transaction reverted." });
      return { proofId: failed.id, provenanceRoot: context.root, anchorStatus: "FAILED", verificationStatus: "UNVERIFIED", transactionHash: hash, provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false };
    }
    const verified = await this.records.recordVerifiedAnchor({
      id: proof.id,
      creatorWallet: identity.wallet,
      chainKey: this.config.network,
      chainId: this.config.chainId,
      transactionHash: hash,
      blockNumber: observed.blockNumber,
      blockTimestamp: observed.blockTimestamp,
      anchorContract: observed.contractAddress,
      anchorEvent: observed.eventName,
    });
    return {
      proofId: verified.id,
      provenanceRoot: context.root,
      chainId: this.config.chainId,
      network: this.config.network,
      transactionHash: hash,
      blockNumber: observed.blockNumber,
      blockTimestamp: observed.blockTimestamp,
      contractAddress: this.config.contractAddress,
      eventName: EVENT_NAME,
      anchorStatus: "ANCHORED",
      verificationStatus: "VERIFIED",
      ...publicationFields(context, { anchor_status: "ANCHORED", verification_status: "VERIFIED" }),
      note: "Verification confirms the on-chain provenance root. It does not establish legal copyright ownership.",
    };
  }
}

export function createProvenanceAnchorService(options) {
  return new ProvenanceAnchorService(options);
}
