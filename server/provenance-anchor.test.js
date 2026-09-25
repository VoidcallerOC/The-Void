import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import fujiRelease from "../config/fuji-release.json" with { type: "json" };
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { ANCHOR_ABI, encodeAnchorCall, inspectAnchorTransaction, loadProvenanceAnchorConfig, ProvenanceAnchorService } from "./provenance-anchor.js";

const owner = "0x1111111111111111111111111111111111111111";
const anchorAddress = "0x3333333333333333333333333333333333333333";
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
const call = encodeAnchorCall({ releaseSlug: "the-record", editionTitleSlug: "chapter-i", provenanceRoot: manifest.root });

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
  };
}

function proof(overrides = {}) {
  return { id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED", transaction_hash: null, manifest_sha256: manifest.root, ...overrides };
}

function logFor(address = anchorAddress) {
  const encoded = iface.encodeEventLog("ProvenanceAnchored", [call.provenanceRoot, call.releaseId, call.editionId, call.tokenId, owner, fujiRelease.contractAddress]);
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
    expect(loadProvenanceAnchorConfig({}).enabled).toBe(false);
    expect(() => loadProvenanceAnchorConfig({ NODE_ENV: "production", PROVENANCE_ANCHOR_CHAIN_ID: "43114", PROVENANCE_ANCHOR_NETWORK: "avalanche" })).toThrow(/Fuji/);
    expect(() => loadProvenanceAnchorConfig({ PROVENANCE_ANCHOR_CHAIN_ID: "43114", PROVENANCE_ANCHOR_NETWORK: "fuji" })).toThrow(/avalanche/);
    expect(() => loadProvenanceAnchorConfig({ PROVENANCE_ANCHOR_CHAIN_ID: "43114", PROVENANCE_ANCHOR_NETWORK: "avalanche", PROVENANCE_RELEASE_CONTRACT: fujiRelease.contractAddress })).toThrow(/Fuji release/);
    expect(() => loadProvenanceAnchorConfig({ PROVENANCE_ANCHOR_ADDRESS: anchorAddress, PROVENANCE_ANCHOR_RPC_URL: "https://user:secret@rpc.example/v1" })).toThrow(/credentials/);
    expect(() => loadProvenanceAnchorConfig({ NODE_ENV: "production", PROVENANCE_ANCHOR_ADDRESS: anchorAddress, PROVENANCE_ANCHOR_RPC_URL: "http://127.0.0.1:8545" })).toThrow(/HTTPS/);
    expect(() => loadProvenanceAnchorConfig({ PROVENANCE_ANCHOR_ADDRESS: fujiRelease.contractAddress, PROVENANCE_ANCHOR_RPC_URL: "https://rpc.example" })).toThrow(/release contract/);
  });
});

describe("provenance anchor verification", () => {
  it("prepares calldata for the configured contract and does not treat that as verification", async () => {
    const anchor = service();
    const prepared = await anchor.prepare({ request: {}, releaseId: "release-1" });
    expect(prepared.contractAddress).toBe(anchorAddress);
    expect(prepared.provenanceRoot).toBe(manifest.root);
    expect(prepared.data).toBe(call.data);
    expect(prepared.verificationStatus).toBe("UNVERIFIED");
    expect(prepared.note).toMatch(/copyright/i);
    expect(prepared.rpcUrl).toBeUndefined();
    expect(anchor.records.recordVerifiedAnchor).not.toHaveBeenCalled();
  });

  it("does not mark a submitted or pending transaction verified", async () => {
    const pending = service({ reader: readerFor({ receipt: null }) });
    await expect(pending.submit({ request: {}, releaseId: "release-1", input: { transactionHash: tx, contractAddress: "0xdead000000000000000000000000000000000001" } })).resolves.toMatchObject({ anchorStatus: "SUBMITTED", verificationStatus: "UNVERIFIED", pending: true });
    expect(pending.records.recordVerifiedAnchor).not.toHaveBeenCalled();
    expect(pending.records.recordSubmittedAnchor).toHaveBeenCalledWith(expect.objectContaining({ anchorContract: anchorAddress, transactionHash: tx }));

    const mined = service({ reader: readerFor() });
    await expect(mined.submit({ request: {}, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ anchorStatus: "SUBMITTED", verificationStatus: "UNVERIFIED" });
    expect(mined.records.recordVerifiedAnchor).not.toHaveBeenCalled();
  });

  it("verifies only after the receipt, event, block, and contract state agree", async () => {
    const anchor = service({ reader: readerFor() });
    await expect(anchor.confirm({ request: {}, releaseId: "release-1", input: { transactionHash: tx, contractAddress: "0xdead000000000000000000000000000000000001" } })).resolves.toMatchObject({
      anchorStatus: "ANCHORED",
      verificationStatus: "VERIFIED",
      chainId: 43113,
      network: "fuji",
      contractAddress: anchorAddress,
      eventName: "ProvenanceAnchored",
      blockNumber: 90,
    });
    expect(anchor.records.recordVerifiedAnchor).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: tx,
      blockNumber: 90,
      anchorContract: anchorAddress,
      anchorEvent: "ProvenanceAnchored",
      chainId: 43113,
      chainKey: "fuji",
    }));
  });

  it("records a reverted transaction as failed and leaves RPC failures unverified", async () => {
    const reverted = service({ reader: readerFor({ receipt: { status: 0, blockNumber: 90, logs: [] } }) });
    await expect(reverted.confirm({ request: {}, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ anchorStatus: "FAILED", verificationStatus: "UNVERIFIED" });
    expect(reverted.records.recordAnchorFailure).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "ANCHOR_TRANSACTION_REVERTED" }));
    expect(reverted.records.recordVerifiedAnchor).not.toHaveBeenCalled();

    const rpc = service({ reader: readerFor({ fail: "receipt" }) });
    await expect(rpc.confirm({ request: {}, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ status: 503, code: "ANCHOR_RPC_UNAVAILABLE" });
    expect(rpc.records.recordVerifiedAnchor).not.toHaveBeenCalled();
    expect(rpc.records.recordSubmittedAnchor).not.toHaveBeenCalled();
  });

  it("fails closed on the wrong chain, contract, or event and retries a failed proof", async () => {
    const wrongChain = service({ reader: readerFor({ chainId: 43114 }) });
    await expect(wrongChain.confirm({ request: {}, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "ANCHOR_CHAIN_MISMATCH" });
    const wrongEvent = service({ reader: readerFor({ receipt: { status: 1, blockNumber: 90, logs: [logFor("0x4444444444444444444444444444444444444444")] } }) });
    await expect(wrongEvent.confirm({ request: {}, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "ANCHOR_EVENT_MISMATCH" });
    expect(wrongEvent.records.recordVerifiedAnchor).not.toHaveBeenCalled();

    const retry = service({
      reader: readerFor({ receipt: null }),
      records: { findOwnedByRoot: vi.fn().mockResolvedValue(proof({ anchor_status: "FAILED", attempt_count: 1 })) },
    });
    await expect(retry.submit({ request: {}, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ verificationStatus: "UNVERIFIED" });
    expect(retry.records.retryProof).toHaveBeenCalledWith({ id: "proof-1", creatorWallet: owner });
  });

  it("does not verify a transaction that was only found by the low-level inspector as pending", async () => {
    await expect(inspectAnchorTransaction({ reader: readerFor({ receipt: null }), config, expected: { transactionHash: tx, wallet: owner, releaseSlug: "the-record", editionTitleSlug: "chapter-i", provenanceRoot: manifest.root } })).resolves.toMatchObject({ outcome: "pending" });
  });
});

describe("provenance anchor HTTP", () => {
  function responseDouble() {
    return { status: null, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  }
  function requestDouble(body) {
    return { method: "POST", url: "/api/studio/releases/release-1/provenance/anchor/confirm", headers: { authorization: "Bearer opaque" }, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  }

  it("routes confirm through the anchor service and stays unavailable without it", async () => {
    const provenanceAnchor = { confirm: vi.fn().mockResolvedValue({ verificationStatus: "VERIFIED" }) };
    const handler = createApiHandler({ service: {}, provenanceAnchor });
    const response = responseDouble();
    await handler(requestDouble({ transactionHash: tx, contractAddress: "0xdead000000000000000000000000000000000001" }), response);
    expect(response.status).toBe(200);
    expect(provenanceAnchor.confirm).toHaveBeenCalledWith(expect.objectContaining({ releaseId: "release-1", input: expect.objectContaining({ transactionHash: tx }) }));

    const missing = responseDouble();
    await createApiHandler({ service: {} })(requestDouble({ transactionHash: tx }), missing);
    expect(missing.status).toBe(503);
    expect(JSON.parse(missing.body).error.code).toBe("PROVENANCE_ANCHOR_UNAVAILABLE");
  });
});
