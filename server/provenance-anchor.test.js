import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import fujiRelease from "../config/fuji-release.json" with { type: "json" };
import fujiPerContractV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { ANCHOR_ABI, encodeAnchorCall, inspectAnchorTransaction, loadProvenanceAnchorConfig, ProvenanceAnchorService } from "./provenance-anchor.js";

const owner = "0x1111111111111111111111111111111111111111";
const anchorAddress = "0x3333333333333333333333333333333333333333";
const boundReleaseAddress = "0x4444444444444444444444444444444444444444";
const releaseKey = `0x${"99".repeat(32)}`;
const tx = `0x${"ab".repeat(32)}`;
const iface = new ethers.Interface(ANCHOR_ABI);
const config = Object.freeze({
  enabled: true,
  chainId: 43113,
  network: "fuji",
  releaseContract: fujiRelease.contractAddress.toLowerCase(),
  contractAddress: anchorAddress,
  rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
  eventName: "ProvenanceAnchored",
});

const manifest = canonicalProvenanceManifest({
  releaseId: "release-1",
  editionId: "edition-1",
  creator: { artistId: "artist-1", wallet: owner },
  metadataDigest: "a".repeat(64),
  createdAt: "2026-09-25T20:00:00.000Z",
  artwork: "b".repeat(64),
});
const call = encodeAnchorCall({ releaseKey, editionTitleSlug: "chapter-i", provenanceRoot: manifest.root });

function editionRow() {
  return {
    release_id: "release-1",
    release_slug: "the-record",
    artist_id: "artist-1",
    edition_id: "edition-1",
    title: "Chapter I",
    token_id: call.tokenId.toString(),
    metadata: { provenance: manifest.record },
    metadata_version: manifest.metadataDigest,
    bound_chain_id: 43113,
    release_key: releaseKey,
    release_contract_address: boundReleaseAddress,
    provenance_anchor_address: anchorAddress,
  };
}

function proof(overrides = {}) {
  return { id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED", transaction_hash: null, manifest_sha256: manifest.root, ...overrides };
}

function logFor(address = anchorAddress) {
  const encoded = iface.encodeEventLog("ProvenanceAnchored", [call.provenanceRoot, call.releaseId, call.editionId, call.tokenId, owner, boundReleaseAddress]);
  return { address, topics: encoded.topics, data: encoded.data };
}

function readerFor({ transaction = { to: anchorAddress, from: owner, data: call.data }, receipt = { status: 1, blockNumber: 90, logs: [logFor()] }, block = { timestamp: 1_758_835_200 }, anchored = true, chainId = 43113, fail = null } = {}) {
  return {
    getNetwork: vi.fn(async () => { if (fail === "network") throw new Error("rpc down"); return { chainId }; }),
    getTransaction: vi.fn(async () => { if (fail === "tx") throw new Error("rpc down"); return transaction; }),
    getTransactionReceipt: vi.fn(async () => { if (fail === "receipt") throw new Error("rpc down"); return receipt; }),
    getBlock: vi.fn(async () => { if (fail === "block") throw new Error("rpc down"); return block; }),
    isAnchored: vi.fn(async () => { if (fail === "state") throw new Error("rpc down"); return anchored; }),
  };
}

function service({ reader, records, row = editionRow() } = {}) {
  const db = { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) };
  return new ProvenanceAnchorService({
    db,
    authenticator: async () => ({ wallet: owner }),
    config,
    reader,
    records: {
      findOwnedByRoot: vi.fn().mockResolvedValue(proof()),
      createProof: vi.fn(),
      retryProof: vi.fn().mockResolvedValue(proof({ anchor_status: "PENDING", attempt_count: 1 })),
      recordSubmittedAnchor: vi.fn().mockResolvedValue(proof({ anchor_status: "SUBMITTED", verification_status: "UNVERIFIED" })),
      recordAnchorFailure: vi.fn().mockResolvedValue(proof({ anchor_status: "FAILED", verification_status: "UNVERIFIED" })),
      recordVerifiedAnchor: vi.fn().mockResolvedValue(proof({ anchor_status: "ANCHORED", verification_status: "VERIFIED" })),
      ...records,
    },
  });
}

describe("provenance anchor configuration", () => {
  it("keeps Fuji and C-Chain configuration separate and rejects embedded secrets", () => {
    const defaultConfig = loadProvenanceAnchorConfig({});
    expect(defaultConfig).toMatchObject({ enabled: true, chainId: 43113, network: "fuji", contractAddress: null, rpcUrl: fujiPerContractV2.rpcUrl });
    expect(() => loadProvenanceAnchorConfig({ NODE_ENV: "production", PROVENANCE_ANCHOR_CHAIN_ID: "43114", PROVENANCE_ANCHOR_NETWORK: "avalanche" })).toThrow(/RELEASE_NETWORK/);
    expect(() => loadProvenanceAnchorConfig({ PROVENANCE_ANCHOR_CHAIN_ID: "43114", PROVENANCE_ANCHOR_NETWORK: "fuji" })).toThrow(/RELEASE_NETWORK/);
    // Mainnet loads; anchoring is enabled once its factory deployment is recorded and authorized.
    expect(loadProvenanceAnchorConfig({ RELEASE_NETWORK: "mainnet" })).toMatchObject({ enabled: true, chainId: 43114, network: "mainnet" });
    expect(() => loadProvenanceAnchorConfig({ PROVENANCE_ANCHOR_ADDRESS: anchorAddress, PROVENANCE_ANCHOR_RPC_URL: "https://user:secret@rpc.example/v1" })).toThrow(/credentials/);
    expect(() => loadProvenanceAnchorConfig({ NODE_ENV: "production", PROVENANCE_ANCHOR_ADDRESS: anchorAddress, PROVENANCE_ANCHOR_RPC_URL: "http://127.0.0.1:8545" })).toThrow(/HTTPS/);
    expect(() => loadProvenanceAnchorConfig({ PROVENANCE_ANCHOR_ADDRESS: fujiRelease.contractAddress, PROVENANCE_ANCHOR_RPC_URL: "https://rpc.example" })).toThrow(/release contract/);
  });
});

// ... rest of file unchanged ...
