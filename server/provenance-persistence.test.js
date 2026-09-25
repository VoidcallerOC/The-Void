import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { ProvenanceRecords } from "./provenance-records.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const metadata = "11".repeat(32);
const artwork = "22".repeat(32);
const audio = "33".repeat(32);
const experience = "44".repeat(32);
const manifest = "55".repeat(32);
const tx = `0x${"ab".repeat(32)}`;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function ignoreAdminTerminate(error) {
  if (!error) return;
  if (error.code === "57P01") return;
  if (String(error.message || "").includes("administrator command")) return;
}

async function closePool(pool) {
  if (!pool) return;
  pool.on("error", ignoreAdminTerminate);
  await pool.end().catch(ignoreAdminTerminate);
}

describe.skipIf(!testDatabaseUrl)("provenance persistence", () => {
  let adminPool;
  const created = [];
  const pools = [];

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    adminPool.on("error", ignoreAdminTerminate);
    for (const role of ["anon", "authenticated"]) {
      const existing = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!existing.rowCount) await adminPool.query(`CREATE ROLE ${role} NOLOGIN`);
    }
  });

  afterAll(async () => {
    for (const pool of pools) await closePool(pool);
    for (const name of created) await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`).catch(ignoreAdminTerminate);
    await closePool(adminPool);
  });

  async function database() {
    const name = `void_prov_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE ${quoteIdent(name)}`);
    created.push(name);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${name}`;
    const config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    const pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 2 });
    pool.on("error", ignoreAdminTerminate);
    pools.push(pool);
    await migrate({ pool, config });
    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('artist-1', 'provenance-artist', 'Provenance Artist')");
    await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet, role) VALUES ('artist-1', $1, 'OWNER')", [owner]);
    await pool.query("INSERT INTO releases (id, artist_id, slug, title) VALUES ('release-1', 'artist-1', 'the-record', 'The Record'), ('release-2', 'artist-1', 'other-record', 'Other')");
    await pool.query("INSERT INTO editions (id, release_id, title) VALUES ('edition-1', 'release-1', 'Chapter I'), ('edition-2', 'release-2', 'Chapter II')");
    return { pool, records: new ProvenanceRecords({ db: pool }) };
  }

  it("creates, rejects duplicates, updates the same proof through failure, retry, and verification, and enforces release ownership", async () => {
    const { pool, records } = await database();
    const createdProof = await records.createProof({
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
    });
    expect(createdProof).toMatchObject({
      id: "proof-1",
      release_id: "release-1",
      edition_id: "edition-1",
      creator_artist_id: "artist-1",
      creator_wallet: owner,
      anchor_status: "PENDING",
      verification_status: "UNVERIFIED",
      attempt_count: 0,
    });
    expect(Object.keys(createdProof)).not.toEqual(expect.arrayContaining(["storage_key", "filename", "bytes"]));

    await expect(records.createProof({
      id: "proof-2",
      releaseId: "release-1",
      editionId: "edition-1",
      creatorWallet: owner,
      metadataSha256: metadata,
      manifestSha256: manifest,
      schemaVersion: 1,
      proofTimestamp: "2026-09-25T20:00:00.000Z",
    })).rejects.toMatchObject({ code: "PROVENANCE_ALREADY_RECORDED" });

    const nextVersion = await records.createProof({
      id: "proof-version-2",
      releaseId: "release-1",
      editionId: "edition-1",
      creatorWallet: owner,
      metadataSha256: metadata,
      manifestSha256: "66".repeat(32),
      schemaVersion: 1,
      proofTimestamp: "2026-09-25T20:05:00.000Z",
    });
    expect(nextVersion.id).toBe("proof-version-2");

    await expect(pool.query(
      `INSERT INTO provenance_proofs (id, release_id, edition_id, creator_artist_id, creator_wallet, metadata_sha256, manifest_sha256, schema_version, proof_timestamp)
       VALUES ('proof-bad-relation', 'release-2', 'edition-1', 'artist-1', $1, $2, $3, 1, now())`,
      [owner, metadata, "77".repeat(32)],
    )).rejects.toMatchObject({ code: "23503" });

    await expect(records.createProof({
      id: "proof-denied",
      releaseId: "release-1",
      editionId: "edition-1",
      creatorWallet: other,
      metadataSha256: metadata,
      manifestSha256: "88".repeat(32),
      schemaVersion: 1,
      proofTimestamp: "2026-09-25T20:00:00.000Z",
    })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });

    const failed = await records.recordAnchorFailure({ id: "proof-1", creatorWallet: owner, failureCode: "ANCHOR_TIMEOUT", failureDetail: "Receipt was not observed.", nextRetryAt: "2026-09-25T21:00:00.000Z" });
    expect(failed).toMatchObject({ id: "proof-1", anchor_status: "FAILED", attempt_count: 1, failure_code: "ANCHOR_TIMEOUT" });
    expect(await pool.query("SELECT count(*)::int AS n FROM provenance_proofs WHERE release_id = 'release-1' AND edition_id = 'edition-1' AND manifest_sha256 = $1", [manifest])).toMatchObject({ rows: [{ n: 1 }] });

    const retried = await records.retryProof({ id: "proof-1", creatorWallet: owner });
    expect(retried).toMatchObject({ id: "proof-1", anchor_status: "PENDING", attempt_count: 1, failure_code: null, verification_status: "UNVERIFIED" });

    const verified = await records.recordVerifiedAnchor({ id: "proof-1", creatorWallet: owner, chainKey: "fuji", chainId: 43113, transactionHash: tx, blockNumber: 90, verifiedAt: "2026-09-25T22:00:00.000Z" });
    expect(verified.anchor_status).toBe("ANCHORED");
    expect(verified.verification_status).toBe("VERIFIED");
    expect(verified.chain_key).toBe("fuji");
    expect(String(verified.chain_id)).toBe("43113");
    expect(verified.transaction_hash).toBe(tx);
    expect(String(verified.block_number)).toBe("90");
    expect(verified.verified_at).toBeTruthy();
    await expect(records.retryProof({ id: "proof-1", creatorWallet: owner })).rejects.toMatchObject({ code: "PROVENANCE_ANCHOR_IMMUTABLE" });

    const locked = await pool.query(`
      SELECT c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'provenance_proofs'
    `);
    expect(locked.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: false, policies: 0 });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE anon");
      let leaked = 0;
      try {
        leaked = (await client.query("SELECT id, metadata_sha256, experience_sha256 FROM provenance_proofs")).rowCount;
      } catch (error) {
        expect(error.code).toBe("42501");
      }
      expect(leaked).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    expect((await pool.query("SELECT id FROM provenance_proofs WHERE id = 'proof-1'")).rowCount).toBe(1);
  });
});
