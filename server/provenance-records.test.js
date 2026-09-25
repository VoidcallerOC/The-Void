import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { migrationBody } from "./migrate.js";
import { ProvenanceRecords } from "./provenance-records.js";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const metadata = "a".repeat(64);
const artwork = "b".repeat(64);
const audio = "c".repeat(64);
const experience = "d".repeat(64);
const manifest = "e".repeat(64);
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
      anchorContract: "0x262B774cf9a1949170B58E2d57F6189980FE757b",
      anchorEvent: "ProvenanceAnchored",
      verifiedAt: "2026-09-25T22:00:00.000Z",
    })).resolves.toMatchObject({ anchor_status: "ANCHORED", verification_status: "VERIFIED", chain_id: 43113, block_number: 90 });
    expect(query.mock.calls[1][1]).toEqual(["proof-1", "2026-09-25T22:00:00.000Z", "fuji", 43113, `0x${"ab".repeat(32)}`, 90, "2026-09-25T22:00:01.000Z", "0x262b774cf9a1949170b58e2d57f6189980fe757b", "ProvenanceAnchored"]);
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
