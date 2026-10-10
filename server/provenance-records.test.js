import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { migrationBody } from "./migrate.js";
import { ANCHOR_EVENTS, ANCHOR_MECHANISMS, ProvenanceRecords } from "./provenance-records.js";
import { CANONICAL_FUJI_RELEASE, LEGACY_FUJI_V1_RELEASE } from "./fuji-contract-scope.js";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const metadata = "a".repeat(64);
const artwork = "b".repeat(64);
const audio = "c".repeat(64);
const experience = "d".repeat(64);
const manifest = "e".repeat(64);
const anchorAddress = "0x9999999999999999999999999999999999999999";
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const input = {
  id: "proof-1",
  releaseId: "release-1",
  editionId: "edition-1",
  creatorWallet: owner,
  metadataSha256: metadata,
  artworkSha256: artwork,
  audioSha256: audio,
  experienceSha256: experience,
  manifestSha256: manifest,
  schemaVersion: 1,
  proofTimestamp: "2026-09-25T20:00:00.000Z",
};

function ownedRow() {
  return { release_id: "release-1", edition_id: "edition-1", artist_id: "artist-1" };
}

function proofRow(overrides = {}) {
  return {
    id: "proof-1",
    release_id: "release-1",
    edition_id: "edition-1",
    creator_artist_id: "artist-1",
    creator_wallet: owner,
    metadata_sha256: metadata,
    artwork_sha256: artwork,
    audio_sha256: audio,
    experience_sha256: experience,
    manifest_sha256: manifest,
    schema_version: 1,
    anchor_status: "PENDING",
    verification_status: "UNVERIFIED",
    attempt_count: 0,
    ...overrides,
  };
}

describe("provenance records", () => {
  it("creates one proof for an owned release edition and stores hashes only", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [ownedRow()] })
      .mockResolvedValueOnce({ rows: [proofRow()] });
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.createProof(input)).resolves.toMatchObject({ id: "proof-1", creator_artist_id: "artist-1", manifest_sha256: manifest });
    expect(query.mock.calls[0][0]).toMatch(/FROM editions e/);
    expect(query.mock.calls[0][0]).toMatch(/JOIN releases r ON r.id = e.release_id/);
    expect(query.mock.calls[0][1]).toEqual(["release-1", "edition-1", owner]);
    const insert = query.mock.calls[1][0];
    expect(insert).toMatch(/INSERT INTO provenance_proofs/);
    expect(insert).not.toMatch(/storage_key|media_config|bytes/);
    expect(query.mock.calls[1][1]).toEqual(["proof-1", "release-1", "edition-1", "artist-1", owner, metadata, artwork, audio, experience, manifest, 1, "2026-09-25T20:00:00.000Z"]);
  });

  it("rejects a wallet that does not own the release", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.createProof({ ...input, creatorWallet: other })).rejects.toMatchObject({ status: 403, code: "ARTIST_ACCESS_DENIED" });
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate canonical release version", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [ownedRow()] })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "23505" }));
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.createProof(input)).rejects.toMatchObject({ status: 409, code: "PROVENANCE_ALREADY_RECORDED" });
  });

  it("rejects a provenance row whose edition is not on that release", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [ownedRow()] })
      .mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "23503" }));
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.createProof(input)).rejects.toMatchObject({ status: 409, code: "PROVENANCE_RELATION_INVALID" });
  });

  it("does not hash a mutable artwork or audio reference", async () => {
    const query = vi.fn();
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.createProof({ ...input, artworkSha256: "https://cdn.example/art.png" })).rejects.toMatchObject({ code: "PROVENANCE_MUTABLE_REFERENCE" });
    await expect(records.createProof({ ...input, audioSha256: "/assets/audio/master.mp3" })).rejects.toMatchObject({ code: "PROVENANCE_MUTABLE_REFERENCE" });
    await expect(records.createProof({ ...input, experienceSha256: "ipfs://bafybeigsecret" })).rejects.toMatchObject({ code: "PROVENANCE_MUTABLE_REFERENCE" });
    expect(query).not.toHaveBeenCalled();
  });

  it("marks a failed anchor without creating another proof", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [proofRow()] })
      .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "FAILED", attempt_count: 1, failure_code: "ANCHOR_TIMEOUT" })] });
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.recordAnchorFailure({ id: "proof-1", creatorWallet: owner, failureCode: "ANCHOR_TIMEOUT", failureDetail: "Receipt was not observed.", nextRetryAt: "2026-09-25T21:00:00.000Z" })).resolves.toMatchObject({ id: "proof-1", anchor_status: "FAILED", attempt_count: 1 });
    expect(query.mock.calls[1][0]).toMatch(/UPDATE provenance_proofs/);
    expect(query.mock.calls[1][0]).not.toMatch(/INSERT INTO provenance_proofs/);
    expect(query.mock.calls[1][1]).toEqual(["proof-1", "ANCHOR_TIMEOUT", "Receipt was not observed.", "2026-09-25T21:00:00.000Z"]);
  });

  it("retries the same proof after failure and refuses to retry a verified anchor", async () => {
    const failed = new ProvenanceRecords({ db: { query: vi.fn()
      .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "FAILED", attempt_count: 1, failure_code: "ANCHOR_TIMEOUT" })] })
      .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "PENDING", attempt_count: 1, failure_code: null })] }) } });
    await expect(failed.retryProof({ id: "proof-1", creatorWallet: owner })).resolves.toMatchObject({ id: "proof-1", anchor_status: "PENDING", attempt_count: 1 });
    expect(failed.db.query.mock.calls[1][0]).toMatch(/anchor_status = 'PENDING'/);
    expect(failed.db.query.mock.calls[1][0]).not.toMatch(/manifest_sha256 =/);

    const verified = new ProvenanceRecords({ db: { query: vi.fn().mockResolvedValue({ rows: [proofRow({ anchor_status: "ANCHORED", verification_status: "VERIFIED" })] }) } });
    await expect(verified.retryProof({ id: "proof-1", creatorWallet: owner })).rejects.toMatchObject({ status: 409, code: "PROVENANCE_ANCHOR_IMMUTABLE" });
    await expect(verified.recordAnchorFailure({ id: "proof-1", creatorWallet: owner, failureCode: "LATE" })).rejects.toMatchObject({ code: "PROVENANCE_ANCHOR_IMMUTABLE" });
  });

  it("records a verified anchor with network, chain, transaction, and block", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "SUBMITTED" })] })
      .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "ANCHORED", verification_status: "VERIFIED", chain_key: "fuji", chain_id: 43113, transaction_hash: `0x${"ab".repeat(32)}`, block_number: 90 })] });
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.recordVerifiedAnchor({
      id: "proof-1",
      creatorWallet: owner,
      chainKey: "fuji",
      chainId: 43113,
      transactionHash: `0x${"AB".repeat(32)}`,
      blockNumber: 90,
      blockTimestamp: "2026-09-25T22:00:01.000Z",
      anchorContract: anchorAddress,
      anchorEvent: "ProvenanceAnchored",
      verifiedAt: "2026-09-25T22:00:00.000Z",
    })).resolves.toMatchObject({ anchor_status: "ANCHORED", verification_status: "VERIFIED", chain_id: 43113, block_number: 90 });
    expect(query.mock.calls[1][1]).toEqual(["proof-1", "2026-09-25T22:00:00.000Z", "fuji", 43113, `0x${"ab".repeat(32)}`, 90, "2026-09-25T22:00:01.000Z", anchorAddress, "ProvenanceAnchored"]);
  });

  it("refuses to verify without a transaction and refuses failure text that points at media", async () => {
    const pending = new ProvenanceRecords({ db: { query: vi.fn().mockResolvedValue({ rows: [proofRow()] }) } });
    await expect(pending.recordVerifiedAnchor({ id: "proof-1", creatorWallet: owner, chainKey: "fuji", chainId: 43113, blockNumber: 1 })).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID" });
    const failed = new ProvenanceRecords({ db: { query: vi.fn().mockResolvedValue({ rows: [proofRow()] }) } });
    await expect(failed.recordAnchorFailure({ id: "proof-1", creatorWallet: owner, failureCode: "BAD", failureDetail: "see ipfs://bafybeigsecret" })).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID" });
    expect(failed.db.query).toHaveBeenCalledOnce();
  });

  it("denies updates from a wallet that does not own the proof", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const records = new ProvenanceRecords({ db: { query } });
    await expect(records.retryProof({ id: "proof-1", creatorWallet: other })).rejects.toMatchObject({ status: 403, code: "ARTIST_ACCESS_DENIED" });
  });

  it("keeps the migration private, constrained, and free of raw media columns", async () => {
    const sql = await readFile(new URL("./migrations/021_provenance_proofs.sql", import.meta.url), "utf8");
    const body = migrationBody(sql, "021_provenance_proofs.sql");
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS provenance_proofs/);
    expect(body).toMatch(/REFERENCES releases\(id\)/);
    expect(body).toMatch(/FOREIGN KEY \(edition_id, release_id\) REFERENCES editions \(id, release_id\)/);
    expect(body).toMatch(/UNIQUE \(release_id, edition_id, schema_version, manifest_sha256\)/);
    expect(body).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(body).not.toMatch(/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/);
    expect(body).not.toMatch(/CREATE POLICY/i);
    expect(body).not.toMatch(/\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
    expect(body).not.toMatch(/storage_key|bytea|media_config|filename/i);
    expect(body).toMatch(/metadata_sha256/);
    expect(body).toMatch(/artwork_sha256/);
    expect(body).toMatch(/audio_sha256/);
    expect(body).toMatch(/experience_sha256/);
    expect(body).toMatch(/manifest_sha256/);
    expect(body).toMatch(/anchor_status/);
    expect(body).toMatch(/verification_status/);
  });
});

describe("Studio publication anchor (EditionCreated on the canonical Fuji release)", () => {
  const tx = `0x${"ab".repeat(32)}`;
  const studioAnchor = (overrides = {}) => ({
    id: "proof-1",
    creatorWallet: owner,
    chainKey: "fuji",
    chainId: 43113,
    transactionHash: tx,
    blockNumber: 90,
    blockTimestamp: "2026-09-25T22:00:01.000Z",
    anchorContract: CANONICAL_FUJI_RELEASE,
    anchorEvent: ANCHOR_EVENTS.EDITION_CREATED,
    mechanism: ANCHOR_MECHANISMS.EditionCreated,
    metadataCid: cid,
    verifiedAt: "2026-09-25T22:00:00.000Z",
    ...overrides,
  });
  const pendingRecords = () => new ProvenanceRecords({ db: { query: vi.fn()
    .mockResolvedValueOnce({ rows: [proofRow()] })
    .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "ANCHORED", verification_status: "VERIFIED", chain_key: "fuji", chain_id: 43113, transaction_hash: tx, block_number: 90, anchor_contract: CANONICAL_FUJI_RELEASE, anchor_event: "EditionCreated" })] }) } });

  it("persists a verified EditionCreated publication anchor with the verifier's evidence", async () => {
    const records = pendingRecords();
    await expect(records.recordVerifiedAnchor(studioAnchor())).resolves.toMatchObject({ anchor_status: "ANCHORED", verification_status: "VERIFIED", anchor_event: "EditionCreated", anchor_contract: CANONICAL_FUJI_RELEASE });
    expect(records.db.query.mock.calls[1][1]).toEqual(["proof-1", "2026-09-25T22:00:00.000Z", "fuji", 43113, tx, 90, "2026-09-25T22:00:01.000Z", CANONICAL_FUJI_RELEASE, "EditionCreated"]);
    expect(ANCHOR_MECHANISMS.EditionCreated).toBe("edition-metadata-cid");
    expect(ANCHOR_MECHANISMS.ProvenanceAnchored).toBe("provenance-anchor");
  });

  it("rejects an unrecognized anchor event before touching the row", async () => {
    for (const anchorEvent of ["TransferSingle", "", "editioncreated"]) {
      const records = new ProvenanceRecords({ db: { query: vi.fn().mockResolvedValue({ rows: [proofRow()] }) } });
      await expect(records.recordVerifiedAnchor(studioAnchor({ anchorEvent }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /anchorEvent must be one of/ });
      expect(records.db.query).toHaveBeenCalledOnce();
      expect(records.db.query.mock.calls[0][0]).not.toMatch(/UPDATE provenance_proofs/);
    }
  });

  it("rejects EditionCreated from the wrong contract, including the historical Fuji V1 release", async () => {
    const v1 = pendingRecords();
    await expect(v1.recordVerifiedAnchor(studioAnchor({ anchorContract: LEGACY_FUJI_V1_RELEASE }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /historical Fuji V1/ });
    const stranger = pendingRecords();
    await expect(stranger.recordVerifiedAnchor(studioAnchor({ anchorContract: anchorAddress }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /canonical Fuji release/ });
    expect(v1.db.query.mock.calls.every(([sql]) => !/UPDATE provenance_proofs/.test(sql))).toBe(true);
    expect(stranger.db.query.mock.calls.every(([sql]) => !/UPDATE provenance_proofs/.test(sql))).toBe(true);
  });

  it("rejects EditionCreated on the wrong chain or network", async () => {
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ chainId: 43114, chainKey: "avalanche" }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /chain 43113/ });
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ chainKey: "avalanche" }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /fuji network/ });
  });

  it("cannot mark an EditionCreated anchor VERIFIED without the publication verifier's result", async () => {
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ mechanism: null, metadataCid: null }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /edition-metadata-cid/ });
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ metadataCid: "" }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /metadata CID/ });
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ metadataCid: "ipfs://not-a-cid" }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /metadata CID/ });
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ mechanism: "provenance-anchor" }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /mechanism/ });
  });

  it("keeps ProvenanceAnchored for the dedicated anchor contract and never for a release collection", async () => {
    const records = new ProvenanceRecords({ db: { query: vi.fn()
      .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "SUBMITTED" })] })
      .mockResolvedValueOnce({ rows: [proofRow({ anchor_status: "ANCHORED", verification_status: "VERIFIED", anchor_event: "ProvenanceAnchored" })] }) } });
    await expect(records.recordVerifiedAnchor(studioAnchor({ anchorEvent: "ProvenanceAnchored", anchorContract: anchorAddress, mechanism: null, metadataCid: null }))).resolves.toMatchObject({ anchor_event: "ProvenanceAnchored" });
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ anchorEvent: "ProvenanceAnchored", anchorContract: CANONICAL_FUJI_RELEASE, mechanism: null, metadataCid: null }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /dedicated anchor contract/ });
    await expect(pendingRecords().recordVerifiedAnchor(studioAnchor({ anchorEvent: "ProvenanceAnchored", anchorContract: LEGACY_FUJI_V1_RELEASE, mechanism: null, metadataCid: null }))).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID", message: /dedicated anchor contract/ });
    const submitted = new ProvenanceRecords({ db: { query: vi.fn().mockResolvedValue({ rows: [proofRow()] }) } });
    await expect(submitted.recordSubmittedAnchor({ id: "proof-1", creatorWallet: owner, chainKey: "fuji", chainId: 43113, transactionHash: tx, anchorContract: CANONICAL_FUJI_RELEASE, anchorEvent: "ProvenanceAnchored" })).rejects.toMatchObject({ code: "PROVENANCE_RECORD_INVALID" });
  });

  it("leaves historical V1 rows untouched: the record layer only rewrites the row it was asked to verify", async () => {
    const records = pendingRecords();
    await records.recordVerifiedAnchor(studioAnchor());
    const [sql, params] = records.db.query.mock.calls[1];
    expect(sql).toMatch(/WHERE id = \$1 AND anchor_status IN \('PENDING', 'SUBMITTED'\) AND verification_status <> 'VERIFIED'/);
    expect(params[0]).toBe("proof-1");
    expect(sql).not.toMatch(/INSERT INTO provenance_proofs/);
  });

  it("never consults release-contract bindings for the canonical or historical release", async () => {
    const canonical = pendingRecords();
    await canonical.recordVerifiedAnchor(studioAnchor());
    expect(canonical.db.query).toHaveBeenCalledTimes(2);
    expect(canonical.db.query.mock.calls.some(([sql]) => /release_contracts/.test(sql))).toBe(false);
    const legacy = pendingRecords();
    expectInvalid(await rejection(legacy.recordVerifiedAnchor(studioAnchor({ anchorContract: LEGACY_FUJI_V1_RELEASE }))), /historical Fuji V1/);
    expect(legacy.db.query.mock.calls.some(([sql]) => /release_contracts/.test(sql))).toBe(false);
  });

  it("keeps the canonical release's exact contract, chain, and network rules", async () => {
    expectInvalid(await rejection(pendingRecords().recordVerifiedAnchor(studioAnchor({ anchorContract: LEGACY_FUJI_V1_RELEASE }))), /^EditionCreated on the historical Fuji V1 release is not a V2 publication anchor\.$/);
    expectInvalid(await rejection(pendingRecords().recordVerifiedAnchor(studioAnchor({ chainId: 43114 }))), /^EditionCreated must be anchored on chain 43113\.$/);
    expectInvalid(await rejection(pendingRecords().recordVerifiedAnchor(studioAnchor({ chainKey: "avalanche" }))), /^EditionCreated must be anchored on the fuji network\.$/);
    expectInvalid(await rejection(pendingRecords().recordVerifiedAnchor(studioAnchor({ chainKey: "43113" }))), /^EditionCreated must be anchored on the fuji network\.$/);
  });
});

// `rejects.toMatchObject({ message: /re/ })` does not constrain an Error's message, so these assert it directly.
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function expectInvalid(error, message) {
  expect(error.code).toBe("PROVENANCE_RECORD_INVALID");
  expect(error.message).toMatch(message);
}

describe("Studio publication anchor (EditionCreated on the release's own bound release contract)", () => {
  const tx = `0x${"ab".repeat(32)}`;
  const releaseContract = "0x4444444444444444444444444444444444444444";
  const boundRow = { address: releaseContract, chain_id: "43113", chain_key: "43113" };
  const releaseContractAnchor = (overrides = {}) => ({
    id: "proof-1",
    creatorWallet: owner,
    chainKey: "43113",
    chainId: 43113,
    transactionHash: tx,
    blockNumber: 90,
    blockTimestamp: "2026-09-25T22:00:01.000Z",
    anchorContract: releaseContract,
    anchorEvent: ANCHOR_EVENTS.EDITION_CREATED,
    mechanism: ANCHOR_MECHANISMS.EditionCreated,
    metadataCid: cid,
    verifiedAt: "2026-09-25T22:00:00.000Z",
    ...overrides,
  });
  const boundRecords = ({ bound = [boundRow], proof = proofRow() } = {}) => new ProvenanceRecords({ db: { query: vi.fn(async (sql) => {
    if (/FROM release_contracts/.test(sql)) return { rows: bound };
    if (/UPDATE provenance_proofs/.test(sql)) return { rows: [proofRow({ anchor_status: "ANCHORED", verification_status: "VERIFIED", chain_key: "43113", chain_id: 43113, transaction_hash: tx, block_number: 90, anchor_contract: releaseContract, anchor_event: "EditionCreated" })] };
    return { rows: [proof] };
  }) } });
  const updated = (records) => records.db.query.mock.calls.some(([sql]) => /UPDATE provenance_proofs/.test(sql));
  const bindingLookup = (records) => records.db.query.mock.calls.find(([sql]) => /FROM release_contracts/.test(sql));
  const NOT_BOUND = /^EditionCreated must come from the canonical Fuji release contract or this release's bound release contract\.$/;

  it("verifies EditionCreated from the release contract bound to the proof's own release, on that contract's chain", async () => {
    const records = boundRecords();
    await expect(records.recordVerifiedAnchor(releaseContractAnchor())).resolves.toMatchObject({ anchor_status: "ANCHORED", verification_status: "VERIFIED", anchor_contract: releaseContract });
    const [sql, params] = bindingLookup(records);
    expect(sql).toMatch(/JOIN contracts c ON c\.id = rc\.release_contract_id/);
    expect(sql).toMatch(/rc\.status IN \('DEPLOYED', 'VERIFIED'\)/);
    expect(params).toEqual(["release-1", releaseContract]);
    const update = records.db.query.mock.calls.find(([text]) => /UPDATE provenance_proofs/.test(text));
    expect(update[1]).toEqual(["proof-1", "2026-09-25T22:00:00.000Z", "43113", 43113, tx, 90, "2026-09-25T22:00:01.000Z", releaseContract, "EditionCreated"]);
  });

  it("scopes the binding lookup to the stored proof's release, not to anything the caller supplies", async () => {
    const records = boundRecords({ bound: [], proof: proofRow({ release_id: "release-2" }) });
    expectInvalid(await rejection(records.recordVerifiedAnchor(releaseContractAnchor())), NOT_BOUND);
    expect(bindingLookup(records)[1]).toEqual(["release-2", releaseContract]);
    expect(updated(records)).toBe(false);
  });

  it("normalizes a checksummed release-contract address before matching the binding", async () => {
    const records = boundRecords();
    await expect(records.recordVerifiedAnchor(releaseContractAnchor({ anchorContract: `0x${releaseContract.slice(2).toUpperCase()}` }))).resolves.toMatchObject({ verification_status: "VERIFIED" });
    expect(bindingLookup(records)[1]).toEqual(["release-1", releaseContract]);
  });

  it("rejects EditionCreated from a contract that is not bound to this release", async () => {
    const unbound = boundRecords({ bound: [] });
    expectInvalid(await rejection(unbound.recordVerifiedAnchor(releaseContractAnchor())), NOT_BOUND);
    expect(updated(unbound)).toBe(false);
    const otherAddress = boundRecords({ bound: [{ ...boundRow, address: anchorAddress }] });
    expectInvalid(await rejection(otherAddress.recordVerifiedAnchor(releaseContractAnchor())), NOT_BOUND);
    expect(updated(otherAddress)).toBe(false);
  });

  it("rejects a bound release contract's EditionCreated on the wrong chain or network", async () => {
    const wrongChain = boundRecords();
    expectInvalid(await rejection(wrongChain.recordVerifiedAnchor(releaseContractAnchor({ chainId: 43114 }))), /^EditionCreated must be anchored on chain 43113\.$/);
    expect(updated(wrongChain)).toBe(false);
    const wrongNetwork = boundRecords();
    expectInvalid(await rejection(wrongNetwork.recordVerifiedAnchor(releaseContractAnchor({ chainKey: "fuji" }))), /^EditionCreated must be anchored on the 43113 network\.$/);
    expect(updated(wrongNetwork)).toBe(false);
  });

  it("still requires the publication verifier's evidence for a release-contract anchor", async () => {
    expectInvalid(await rejection(boundRecords().recordVerifiedAnchor(releaseContractAnchor({ mechanism: null, metadataCid: null }))), /edition-metadata-cid/);
    expectInvalid(await rejection(boundRecords().recordVerifiedAnchor(releaseContractAnchor({ metadataCid: "ipfs://not-a-cid" }))), /metadata CID/);
  });

  it("does not let a release contract's address stand in for the canonical release's Fuji rules or the legacy collections", async () => {
    const legacyAsBound = boundRecords({ bound: [{ ...boundRow, address: LEGACY_FUJI_V1_RELEASE }] });
    expectInvalid(await rejection(legacyAsBound.recordVerifiedAnchor(releaseContractAnchor({ anchorContract: LEGACY_FUJI_V1_RELEASE }))), /historical Fuji V1/);
    expect(bindingLookup(legacyAsBound)).toBeUndefined();
    const canonicalOnReleaseChainKey = boundRecords();
    expectInvalid(await rejection(canonicalOnReleaseChainKey.recordVerifiedAnchor(releaseContractAnchor({ anchorContract: CANONICAL_FUJI_RELEASE }))), /^EditionCreated must be anchored on the fuji network\.$/);
    expect(bindingLookup(canonicalOnReleaseChainKey)).toBeUndefined();
  });
});
