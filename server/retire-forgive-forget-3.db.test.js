import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate, migrationBody, migrationsDirectory } from "./migrate.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: migration 046 retires the abandoned Forgive & Forget draft by exact ID. Fixtures mirror the production
// shapes inspected read-only on 2026-10-22; nothing here reads or writes production. Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const MIGRATION = "046_retire_forgive_forget_3_clean_reset.sql";
const CHAIN = 43114;
const OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const FACTORY = "0xe744d58fa8138042f5f00a28d39f89081539c19b";
const NEW_CLONE = "0xa2f1ba71e2a65d3f9e61679e4d76def8710e6236";
const ABANDONED = "release-84f72628-2c74-4a53-96db-fe495f0f9220";
const SAME_TITLE_NEW_DRAFT = "release-new-same-title-draft";
const BYSTANDER = "release-bystander-draft";
const PUBLISHED = "voidcaller-legacy-genesis";
const TX = "0x3a3d27a94124535c424f3e4f56d9542431f87cd841f2e12ffd50e9aa22bff06b";
const KEY = "0xcb93952ad8afa7eafb855ec4d6b029f3063134a4e7bb34f182ec6c98348918a2";

describe.skipIf(!testDatabaseUrl)("Clean reset of Forgive & Forget (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let config;
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const digest = async (sql) => (await q(`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM (${sql}) t`))[0].d;
  const protectedDigests = () => Promise.all([
    digest("SELECT * FROM tokens"),
    digest("SELECT * FROM contracts"),
    digest("SELECT * FROM release_contracts"),
    digest("SELECT * FROM release_provisioning_requests"),
    digest("SELECT * FROM editions"),
    digest("SELECT * FROM experiences"),
    digest(`SELECT * FROM releases WHERE id IN ('${BYSTANDER}','${PUBLISHED}','${SAME_TITLE_NEW_DRAFT}')`),
  ]);
  const applyMigration = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migrationBody(await readFile(join(migrationsDirectory, MIGRATION), "utf8"), MIGRATION));
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_retire_ff3_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    const before = await mkdtemp(join(tmpdir(), "void-migrations-"));
    for (const name of (await readdir(migrationsDirectory)).filter((file) => file < MIGRATION)) await copyFile(join(migrationsDirectory, name), join(before, name));
    await migrate({ pool, config, directory: before });

    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('voidcaller','voidcaller','Voidcaller') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet) VALUES ('voidcaller',$1) ON CONFLICT DO NOTHING", [OWNER]);
    const metadata = JSON.stringify({ chainId: CHAIN, releaseType: "SINGLE", releaseKey: KEY, artwork: "ipfs://bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i" });
    const releases = [[ABANDONED, "forgive-forget-3", "DRAFT"], [SAME_TITLE_NEW_DRAFT, "forgive-forget-4", "DRAFT"], [BYSTANDER, "bystander", "DRAFT"], [PUBLISHED, "voidcaller-legacy-genesis", "PUBLISHED"]];
    for (const [id, slug, status] of releases) {
      await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata, published_at) VALUES ($1,'voidcaller',$2,'Forgive & Forget',$3,$4, CASE WHEN $3='PUBLISHED' THEN now() END) ON CONFLICT (id) DO NOTHING", [id, slug, status, metadata]);
    }
    await pool.query("INSERT INTO contracts (chain_id, chain_key, address, contract_type) VALUES ($1,'avalanche',$2,'ERC1155')", [CHAIN, NEW_CLONE]);
    await pool.query("INSERT INTO release_provisioning_requests (release_id, chain_id, release_key, artist_wallet, factory_address, authorization_digest, expected_parameters, transaction_hash, state) VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,'SUBMITTED')", [ABANDONED, CHAIN, KEY, OWNER, FACTORY, `0x${"cf".repeat(32)}`, TX]);
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  let digestsBefore;

  it("archives exactly the abandoned draft by ID and marks it abandoned", async () => {
    digestsBefore = await protectedDigests();
    await applyMigration();
    expect(await q("SELECT id, status, release_metadata->'abandoned'->>'reason' AS reason, release_metadata->>'releaseKey' AS key FROM releases WHERE id=$1", [ABANDONED])).toEqual([{ id: ABANDONED, status: "ARCHIVED", reason: "OWNER_RESET_BEFORE_CONTRACT_BINDING", key: KEY }]);
  });

  it("leaves the provisioning request, contracts, tokens, editions and every other release untouched", async () => {
    expect(await protectedDigests()).toEqual(digestsBefore);
    expect(await q("SELECT state, transaction_hash FROM release_provisioning_requests WHERE release_id=$1", [ABANDONED])).toEqual([{ state: "SUBMITTED", transaction_hash: TX }]);
    expect(await q("SELECT id, status FROM releases WHERE id IN ($1,$2,$3) ORDER BY id", [SAME_TITLE_NEW_DRAFT, BYSTANDER, PUBLISHED])).toEqual([
      { id: SAME_TITLE_NEW_DRAFT, status: "DRAFT" }, { id: BYSTANDER, status: "DRAFT" }, { id: PUBLISHED, status: "PUBLISHED" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("writes one audit event that preserves the creation transaction, the clone and the release key", async () => {
    const audit = await q("SELECT subject_id, chain_id, payload FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ subject_id: ABANDONED, chain_id: String(CHAIN), payload: { releaseContractAddress: NEW_CLONE, creationTransactionHash: TX, creationBlock: 98250592, releaseKey: KEY } });
  });

  it("is a no-op when run again and is recorded once by the migration runner", async () => {
    const snapshot = JSON.stringify(await q("SELECT id, status, updated_at FROM releases ORDER BY id"));
    await applyMigration();
    expect(JSON.stringify(await q("SELECT id, status, updated_at FROM releases ORDER BY id"))).toBe(snapshot);
    const result = await migrate({ pool, config });
    expect(result.applied).toContain(MIGRATION);
    await migrate({ pool, config });
    expect(await q("SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
  });

  it("does not touch a release that is already published", async () => {
    await pool.query("UPDATE releases SET status='PUBLISHED' WHERE id=$1", [ABANDONED]);
    await pool.query("DELETE FROM audit_events WHERE payload->>'migration'=$1", [MIGRATION]);
    await applyMigration();
    expect(await q("SELECT status FROM releases WHERE id=$1", [ABANDONED])).toEqual([{ status: "PUBLISHED" }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 0 }]);
  });
});
