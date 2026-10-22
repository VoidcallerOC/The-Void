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

// Real Postgres: migration 045 retires the broken Forgive & Forget single by exact ID. Fixture rows mirror the
// production IDs and shapes the migration targets (read-only inspection, 2026-10-22); nothing here reads or writes
// production. Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const MIGRATION = "045_retire_broken_forgive_forget_single.sql";
const CHAIN = 43114;
const OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const FACTORY = "0xe744d58fa8138042f5f00a28d39f89081539c19b";
const CLONE = "0x8192cc13caec165afd802af691f952573bb3d817";
const SALE = "0x1091af3886a43896d5804f785782db911c308d81";
const ANCHOR = "0xd07ae2b67528958303e1f1130d97b2e433aff24e";
const OTHER_CLONE = "0x09969f81308f28516736492ddded643abac5670d";
const IMPLEMENTATION = "0x36c5d31e9a8e9b4dc9f8cb4b7202c70b3e30734d";
const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const STALE_TOKEN = "80869978042730277877219794306361836567865233348612780024462835156775061640117";
const BROKEN = "release-cd9c689c-8b90-41ee-b4e4-0124a63d6819";
const ED_MAIN = "edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad";
const ED_LEFTOVER = "edition-a5a399c6-5712-4be5-b70b-dfa032dae77d";
const EXP_DEMO = "experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-experience-audio";
const EXP_FULL = "experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-full-track";
const BYSTANDER = "release-bystander-draft";
const BYSTANDER_EDITION = "edition-bystander";
const PUBLISHED = "voidcaller-legacy-genesis";

describe.skipIf(!testDatabaseUrl)("Retire the broken Forgive & Forget single (Postgres)", () => {
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
    digest(`SELECT * FROM releases WHERE id IN ('${BYSTANDER}','${PUBLISHED}')`),
    digest(`SELECT * FROM editions WHERE release_id IN ('${BYSTANDER}','${PUBLISHED}')`),
    digest(`SELECT * FROM experiences WHERE release_id IN ('${BYSTANDER}','${PUBLISHED}')`),
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
    dbName = `void_retire_single_${randomBytes(6).toString("hex")}`;
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
    const releases = [[BROKEN, "forgive-and-forget", "DRAFT"], [BYSTANDER, "bystander", "DRAFT"], [PUBLISHED, "voidcaller-legacy-genesis", "PUBLISHED"]];
    for (const [id, slug, status] of releases) {
      await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata, published_at) VALUES ($1,'voidcaller',$2,'Forgive & Forget',$3,$4, CASE WHEN $3='PUBLISHED' THEN now() END) ON CONFLICT (id) DO NOTHING", [id, slug, status, JSON.stringify({ chainId: CHAIN, releaseType: "SINGLE" })]);
    }
    const contractId = async (address, type = "ERC1155") => (await q("INSERT INTO contracts (chain_id, chain_key, address, contract_type) VALUES ($1,'avalanche',$2,$3) RETURNING id", [CHAIN, address, type]))[0].id;
    const cloneId = await contractId(CLONE);
    const saleId = await contractId(SALE);
    const anchorId = await contractId(ANCHOR);
    const factoryId = await contractId(FACTORY, "OTHER");
    const otherCloneId = await contractId(OTHER_CLONE);
    const editions = [[ED_MAIN, BROKEN, "DRAFT", 0, cloneId], [ED_LEFTOVER, BROKEN, "DRAFT", 25, null], [BYSTANDER_EDITION, BYSTANDER, "DRAFT", 0, otherCloneId]];
    for (const [id, release, status, supply, contract] of editions) await pool.query("INSERT INTO editions (id, release_id, title, status, supply, contract_id) VALUES ($1,$2,'Forgive & Forget',$3,$4,$5)", [id, release, status, supply, contract]);
    // Both token rows of the broken edition (one stale, one with the draft URI) exist in production and must survive.
    await pool.query("INSERT INTO tokens (edition_id, contract_id, token_id, metadata_uri) VALUES ($1,$2,$3,NULL),($1,$2,$4,'ipfs://QmfBD1x4ofcPPqU236kHYaQzfiWJzuEgW5Vcq7cuqSwXfH')", [ED_MAIN, cloneId, STALE_TOKEN, TOKEN]);
    await pool.query("INSERT INTO release_contracts (release_id, chain_id, release_contract_id, factory_contract_id, primary_sale_contract_id, provenance_anchor_contract_id, release_key, artist_wallet, implementation_address, implementation_version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2,'DEPLOYED')", [BROKEN, CHAIN, cloneId, factoryId, saleId, anchorId, `0x${"63".repeat(32)}`, OWNER, IMPLEMENTATION]);
    await pool.query("INSERT INTO release_provisioning_requests (release_id, chain_id, release_key, artist_wallet, factory_address, authorization_digest, expected_parameters, transaction_hash, state) VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,'CONFIRMED')", [BROKEN, CHAIN, `0x${"63".repeat(32)}`, OWNER, FACTORY, `0x${"11".repeat(32)}`, `0x${"a6".repeat(32)}`]);
    const experience = (id, release, edition, type, status) => pool.query("INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, status) VALUES ($1,'voidcaller',$2,$3,'Experience',$4,'[]','{}',$5)", [id, release, edition, type, status]);
    await experience(EXP_DEMO, BROKEN, ED_MAIN, "DEMO", "DRAFT");
    await experience(EXP_FULL, BROKEN, ED_MAIN, "AUDIO", "DRAFT");
    await experience("experience-bystander", BYSTANDER, BYSTANDER_EDITION, "AUDIO", "DRAFT");
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  let digestsBefore;

  it("archives exactly the broken release, its two editions and its two experiences, by ID, and marks them abandoned", async () => {
    digestsBefore = await protectedDigests();
    await applyMigration();
    expect(await q("SELECT id, status, release_metadata->'abandoned'->>'reason' AS reason FROM releases WHERE id=$1", [BROKEN])).toEqual([{ id: BROKEN, status: "ARCHIVED", reason: "ON_CHAIN_EDITION_DIVERGED_FROM_DRAFT" }]);
    expect(await q("SELECT id, status, application_metadata->'abandoned'->>'migration' AS migration FROM editions WHERE release_id=$1 ORDER BY id", [BROKEN])).toEqual([
      { id: ED_MAIN, status: "ARCHIVED", migration: MIGRATION },
      { id: ED_LEFTOVER, status: "ARCHIVED", migration: MIGRATION },
    ]);
    expect(await q("SELECT id, status FROM experiences WHERE release_id=$1 ORDER BY id", [BROKEN])).toEqual([{ id: EXP_DEMO, status: "ARCHIVED" }, { id: EXP_FULL, status: "ARCHIVED" }]);
  });

  it("leaves tokens (both rows), contracts, the clone binding, provisioning and every other release untouched", async () => {
    expect(await protectedDigests()).toEqual(digestsBefore);
    expect(await q("SELECT count(*)::int AS n FROM tokens WHERE edition_id=$1", [ED_MAIN])).toEqual([{ n: 2 }]);
    expect(await q("SELECT status FROM release_contracts WHERE release_id=$1", [BROKEN])).toEqual([{ status: "DEPLOYED" }]);
    expect(await q("SELECT status FROM releases WHERE id IN ($1,$2) ORDER BY id", [BYSTANDER, PUBLISHED])).toEqual([{ status: "DRAFT" }, { status: "PUBLISHED" }]);
  });

  it("writes one audit event that preserves the clone, the creation transaction and both URIs", async () => {
    const audit = await q("SELECT subject_id, chain_id, payload FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ subject_id: BROKEN, chain_id: String(CHAIN), payload: {
      releaseContractAddress: CLONE,
      creationTransactionHash: "0x7d1746aaf2b944aad17822b0ca4396c85dabb93447415368b86f330a6e98a639",
      onChainMetadataUri: "ipfs://QmTExGu6JA9CWD7dBRvjSEevwQiSMBrXhyj1H2RuD7hw95",
      draftMetadataUri: "ipfs://QmfBD1x4ofcPPqU236kHYaQzfiWJzuEgW5Vcq7cuqSwXfH",
    } });
  });

  it("is a no-op when run again and is recorded once by the migration runner", async () => {
    const snapshot = JSON.stringify(await q("SELECT id, status, updated_at FROM releases UNION ALL SELECT id, status, updated_at FROM editions ORDER BY id"));
    await applyMigration();
    expect(JSON.stringify(await q("SELECT id, status, updated_at FROM releases UNION ALL SELECT id, status, updated_at FROM editions ORDER BY id"))).toBe(snapshot);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    const result = await migrate({ pool, config });
    expect(result.applied).toContain(MIGRATION);
    await migrate({ pool, config });
    expect(await q("SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
  });

  it("does not touch a release that is already published or archived", async () => {
    await pool.query("UPDATE releases SET status='PUBLISHED' WHERE id=$1", [BROKEN]);
    await pool.query("DELETE FROM audit_events WHERE payload->>'migration'=$1", [MIGRATION]);
    await applyMigration();
    expect(await q("SELECT status FROM releases WHERE id=$1", [BROKEN])).toEqual([{ status: "PUBLISHED" }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 0 }]);
  });
});
