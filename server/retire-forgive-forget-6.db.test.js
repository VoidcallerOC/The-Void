import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiService } from "./api-service.js";
import { loadServerConfig } from "./config.js";
import { createIndexerStore } from "./indexer-store.js";
import { migrate, migrationBody, migrationsDirectory } from "./migrate.js";
import { createPersistenceRepository } from "./repositories.js";
import { ArtistStudioService } from "./studio-service.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";
import { mapPublishedCatalog } from "../src/lib/catalog-source.js";
import { mapReleaseBindings } from "../src/lib/sale-earnings.js";
import { studioReleaseChoices } from "../src/lib/studio-release-choices.js";
import { resumeOwnedRelease } from "../src/lib/studio-selection.js";
import { planCatalogExperiences } from "../src/lib/studio-experiences.js";

// Real Postgres (every migration before 049, then the forgive-forget-6 retirement): the published mainnet Forgive &
// Forget is retired in the application so the sequential-ID replacement can be the only active one. Fixture rows
// mirror the production IDs and shapes read on 2026-10-23 (public API and chain, read-only); nothing here reads or
// writes production. Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const MIGRATION = "049_retire_forgive_forget_6_replaced_by_sequential.sql";
const MIGRATION_PATH = join(migrationsDirectory, MIGRATION);
const CHAIN = 43114;
const OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const FACTORY = "0xe744d58fa8138042f5f00a28d39f89081539c19b";
const SEQUENTIAL_FACTORY = "0x5e9e000000000000000000000000000000000004";
const CLONE = "0xf9c48a2bbceba7577ff17a2eed20fcef70ea480d";
const SALE = "0xa0000f9489c940e2b99d654700bd425ca36f6921";
const ANCHOR = "0x728d49778df3c468330cd08906d56defd7e0d4b9";
const NEW_CLONE = "0x5e9e000000000000000000000000000000000c01";
const NEW_SALE = "0x5e9e000000000000000000000000000000000501";
const NEW_ANCHOR = "0x5e9e000000000000000000000000000000000a01";
const IMPLEMENTATION = "0x36c5d31e9a8e9b4dc9f8cb4b7202c70b3e30734d";
const RELEASE_KEY = "0x57371429a7c093bcb8394341b928da3230fccde63c61359ec6b34713cc9af3db";
const NEW_RELEASE_KEY = `0x${"5e".repeat(32)}`;
const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const CREATION_TX = "0x5de469e259278ef6815756ce024731baff1f7b455385a66c87d8f1b38a84dce6";

const TARGET = "release-e3743294-2ea3-46ae-b006-f0402606af65";
const TARGET_EDITION = "edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d";
const EXP_DEMO = `experience-${TARGET_EDITION}-experience-audio`;
const EXP_FULL = `experience-${TARGET_EDITION}-full-track`;
const REPLACEMENT = "release-sequential-forgive-forget";
const REPLACEMENT_EDITION = "edition-sequential-forgive-forget";
const GENESIS = "voidcaller-legacy-genesis";
const GENESIS_EDITION = "voidcaller-legacy-edition";
const UNRELATED = "release-unrelated-published";
const DEMO_ASSET = "asset-forgive-forget-6-demo";
const FULL_ASSET = "asset-forgive-forget-6-full";
const ACTIVE_ASSET = "asset-held-by-genesis";
const TARGET_IDS = [TARGET, TARGET_EDITION, EXP_DEMO, EXP_FULL].sort();
const FORM = { productType: "DEMO", experienceTitle: "Stranger Things - Demo", experienceDescription: "", trackTitle: "Forgive & Forget", releaseTitle: "Forgive & Forget" };
const request = { requestId: "request-1", headers: {} };

describe.skipIf(!testDatabaseUrl)("Retire forgive-forget-6 for the sequential-ID replacement (Postgres, migration 049)", () => {
  let adminPool;
  let pool;
  let dbName;
  let config;
  let studio;
  let api;
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const statuses = async () => Object.fromEntries((await q("SELECT id, status FROM releases UNION ALL SELECT id, status FROM editions UNION ALL SELECT id, status FROM experiences")).map((row) => [row.id, row.status]));
  const digest = async (sql) => (await q(`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM (${sql}) t`))[0].d;
  const protectedDigests = () => Promise.all([
    digest("SELECT * FROM media_assets"),
    digest("SELECT * FROM tokens"),
    digest("SELECT * FROM contracts"),
    digest("SELECT * FROM release_contracts"),
    digest("SELECT * FROM factory_releases"),
    digest("SELECT * FROM release_provisioning_requests"),
    digest("SELECT * FROM primary_purchases"),
    digest("SELECT * FROM ownership_snapshots"),
    digest("SELECT * FROM transfers"),
    digest("SELECT * FROM artists"),
    digest("SELECT * FROM artist_owners"),
    // Every other release, edition and experience, including updated_at.
    digest(`SELECT * FROM releases WHERE id <> '${TARGET}'`),
    digest(`SELECT * FROM editions WHERE release_id <> '${TARGET}'`),
    digest(`SELECT * FROM experiences WHERE release_id <> '${TARGET}' AND edition_id <> '${TARGET_EDITION}'`),
    // The retired rows keep every column except status, updated_at and the added marker.
    digest(`SELECT id, artist_id, slug, title, description, release_metadata - 'abandoned', published_at FROM releases WHERE id='${TARGET}'`),
    digest(`SELECT id, release_id, contract_id, title, supply, tier, application_metadata - 'abandoned' FROM editions WHERE release_id='${TARGET}'`),
    digest(`SELECT id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, version FROM experiences WHERE release_id='${TARGET}'`),
  ]);
  const applyMigration = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migrationBody(await readFile(MIGRATION_PATH, "utf8"), MIGRATION));
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  const save = async (editionId, files) => {
    const plans = planCatalogExperiences({ ...FORM, editionId, ...files });
    for (const plan of plans) await studio.createExperience({ request, editionId, input: plan.payload });
    return plans;
  };
  const studioCatalog = async () => {
    const payload = await studio.listCatalog({ request });
    return { ...mapPublishedCatalog(payload), releaseBindings: mapReleaseBindings(payload.releaseBindings) };
  };
  const trackedClones = async () => (await createIndexerStore(pool).listFactoryReleases({ chainId: CHAIN, factoryAddress: FACTORY })).map((row) => row.release_contract_address.toLowerCase());

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_retire_ff6_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    // Production before activation: every migration up to 048, so 049 is still unapplied when the fixtures exist.
    const before = await mkdtemp(join(tmpdir(), "void-migrations-"));
    for (const name of (await readdir(migrationsDirectory)).filter((file) => file < MIGRATION)) await copyFile(join(migrationsDirectory, name), join(before, name));
    await migrate({ pool, config, directory: before });

    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('voidcaller','voidcaller','Voidcaller'), ('other-artist','other-artist','Other Artist') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet) VALUES ('voidcaller',$1) ON CONFLICT DO NOTHING", [OWNER]);
    const releaseRow = (id, artist, slug, title, status, metadata) => pool.query(
      "INSERT INTO releases (id, artist_id, slug, title, status, release_metadata, published_at) VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5='PUBLISHED' THEN now() END) ON CONFLICT (id) DO NOTHING",
      [id, artist, slug, title, status, JSON.stringify(metadata)]);
    // Production state on 2026-10-23: forgive-forget-6 is PUBLISHED with its on-chain edition; the replacement is a
    // new DRAFT on its own sequential clone; Genesis and an unrelated release are PUBLISHED.
    await releaseRow(TARGET, "voidcaller", "forgive-forget-6", "Forgive & Forget", "PUBLISHED", { applicationReleaseId: `0x${"98".repeat(32)}`, chainId: CHAIN, contractSymbol: "FNF", publicationArchitecture: "release-per-contract", releaseKey: RELEASE_KEY, releaseType: "SINGLE" });
    await releaseRow(REPLACEMENT, "voidcaller", "forgive-forget-7", "Forgive & Forget", "DRAFT", { chainId: CHAIN, contractSymbol: "FNF", publicationArchitecture: "release-per-contract", releaseKey: NEW_RELEASE_KEY, releaseType: "SINGLE" });
    await releaseRow(GENESIS, "voidcaller", GENESIS, "VOIDCALLER", "PUBLISHED", { chainId: CHAIN, legacy: true });
    await releaseRow(UNRELATED, "other-artist", "unrelated", "Unrelated Single", "PUBLISHED", {});

    const contractId = async (address, type = "ERC1155") => (await q("INSERT INTO contracts (chain_id, chain_key, address, contract_type) VALUES ($1,'avalanche',$2,$3) RETURNING id", [CHAIN, address, type]))[0].id;
    const ids = {};
    for (const [key, address] of Object.entries({ CLONE, SALE, ANCHOR, NEW_CLONE, NEW_SALE, NEW_ANCHOR, FACTORY, SEQUENTIAL_FACTORY })) ids[key] = await contractId(address, key.includes("FACTORY") ? "OTHER" : "ERC1155");
    const binding = (release, contract, sale, anchor, factory, key, version) => pool.query(
      "INSERT INTO release_contracts (release_id, chain_id, release_contract_id, factory_contract_id, primary_sale_contract_id, provenance_anchor_contract_id, release_key, artist_wallet, implementation_address, implementation_version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DEPLOYED')",
      [release, CHAIN, ids[contract], ids[factory], ids[sale], ids[anchor], key, OWNER, IMPLEMENTATION, version]);
    await binding(TARGET, "CLONE", "SALE", "ANCHOR", "FACTORY", RELEASE_KEY, 2);
    await binding(REPLACEMENT, "NEW_CLONE", "NEW_SALE", "NEW_ANCHOR", "SEQUENTIAL_FACTORY", NEW_RELEASE_KEY, 4);
    // The indexer's own record of the clone (from ReleaseCreated). It matches the release through releaseKey.
    await pool.query(
      "INSERT INTO factory_releases (chain_id, factory_address, release_contract_address, release_key, artist_wallet, primary_sale_address, provenance_anchor_address, implementation_address, factory_index, implementation_version, deployment_block_number, transaction_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,5,2,98340000,$9)",
      [CHAIN, FACTORY, CLONE, RELEASE_KEY, OWNER, SALE, ANCHOR, IMPLEMENTATION, `0x${"7e".repeat(32)}`]);

    const publicationAttempt = { transactionHash: CREATION_TX, tokenId: TOKEN, emittedTokenId: TOKEN, confirmedBlock: 98342872 };
    await pool.query("INSERT INTO editions (id, release_id, contract_id, title, status, supply, application_metadata) VALUES ($1,$2,$3,'Forgive & Forget','PUBLISHED',0,$4)", [TARGET_EDITION, TARGET, ids.CLONE, JSON.stringify({ includes: ["Forgive & Forget - Full Track"], publicationAttempt })]);
    await pool.query("INSERT INTO tokens (edition_id, contract_id, token_id, metadata_uri) VALUES ($1,$2,$3,'ipfs://Qmcwu7vxKLebsRVfvKL1cwkom8rnLPuCadZu8L4gQkWPWF')", [TARGET_EDITION, ids.CLONE, TOKEN]);
    // The replacement's track, reserved as sequential token 1 on its own clone.
    await pool.query("INSERT INTO editions (id, release_id, contract_id, title, status, supply) VALUES ($1,$2,$3,'Forgive & Forget','DRAFT',0)", [REPLACEMENT_EDITION, REPLACEMENT, ids.NEW_CLONE]);
    await pool.query("INSERT INTO tokens (edition_id, contract_id, token_id) VALUES ($1,$2,1)", [REPLACEMENT_EDITION, ids.NEW_CLONE]);
    // Migration 019 seeds the Genesis release and edition; they stay as seeded.
    await pool.query("INSERT INTO editions (id, release_id, title, status, supply) VALUES ($1,$2,'Chapter I','PUBLISHED',1620) ON CONFLICT (id) DO NOTHING", [GENESIS_EDITION, GENESIS]);
    await pool.query("INSERT INTO editions (id, release_id, title, status, supply) VALUES ('edition-unrelated',$1,'Unrelated Single','PUBLISHED',10)", [UNRELATED]);

    for (const [id, type] of [[DEMO_ASSET, "DEMO"], [FULL_ASSET, "AUDIO"], [ACTIVE_ASSET, "AUDIO"]]) {
      await pool.query("INSERT INTO media_assets (media_key, id, artist_id, media_type, storage_key, visibility, metadata) VALUES ($1,$1,'voidcaller',$2,$3,'PROTECTED','{\"byteSize\":1000}')", [id, type, `cid-${id}`]);
    }
    const requirement = (contract, tokenId) => JSON.stringify([{ type: "erc1155-balance", contract, chainId: CHAIN, tokenIds: [tokenId], minAmount: "1" }]);
    const experience = (id, artist, release, edition, asset, type, status, contract, tokenId, primary) => pool.query(
      "INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, status) VALUES ($1,$2,$3,$4,'Experience',$5,$6,$7,$8)",
      [id, artist, release, edition, type, requirement(contract, tokenId), JSON.stringify({ protected: true, primary, protectedMedia: [{ assetId: asset, mediaType: type }] }), status]);
    await experience(EXP_DEMO, "voidcaller", TARGET, TARGET_EDITION, DEMO_ASSET, "DEMO", "PUBLISHED", CLONE, TOKEN, false);
    await experience(EXP_FULL, "voidcaller", TARGET, TARGET_EDITION, FULL_ASSET, "AUDIO", "PUBLISHED", CLONE, TOKEN, true);
    await experience("experience-genesis", "voidcaller", GENESIS, GENESIS_EDITION, ACTIVE_ASSET, "AUDIO", "PUBLISHED", "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", "1", true);
    await pool.query("INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, status) VALUES ('experience-unrelated','other-artist',$1,'edition-unrelated','Unrelated','AUDIO','[]','{}','PUBLISHED')", [UNRELATED]);

    studio = new ArtistStudioService({ db: pool, repository: createPersistenceRepository(pool), authenticator: async () => ({ wallet: OWNER }), logger: { info() {}, error() {} } });
    api = new ApiService({ db: pool, repository: {}, logger: { info() {}, error() {} } });
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  let digestsBefore;
  let statusBefore;

  it("before retirement: the old release is public, Studio opens it as published, the indexer tracks it, and it reserves both files", async () => {
    digestsBefore = await protectedDigests();
    statusBefore = await statuses();
    expect((await api.listReleases({ limit: 100, offset: 0 })).map((row) => row.id)).toContain(TARGET);
    expect((await api.listEditions({ limit: 100, offset: 0 })).map((row) => row.id)).toContain(TARGET_EDITION);
    expect(resumeOwnedRelease(await studioCatalog(), TARGET)).toMatchObject({ published: true, tokenId: TOKEN });
    expect(await trackedClones()).toContain(CLONE);
    await expect(save(REPLACEMENT_EDITION, { experienceAudio: { assetId: DEMO_ASSET, mediaType: "DEMO", contentType: "audio/mpeg" } })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    await expect(save(REPLACEMENT_EDITION, { fullTrack: { assetId: FULL_ASSET, mediaType: "AUDIO", contentType: "audio/wav" } })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    expect(await q("SELECT id FROM experiences WHERE edition_id=$1", [REPLACEMENT_EDITION])).toHaveLength(0);
  });

  it("archives exactly the release, its edition and its two experiences, by ID, with the abandoned marker, and nothing else", async () => {
    await applyMigration();
    const now = await statuses();
    const changed = Object.keys(now).filter((id) => now[id] !== statusBefore[id]).sort();
    expect(changed).toEqual(TARGET_IDS);
    for (const id of TARGET_IDS) expect(now[id]).toBe("ARCHIVED");
    expect(Object.keys(now)).toHaveLength(Object.keys(statusBefore).length);
    expect(now[REPLACEMENT]).toBe("DRAFT");
    expect(now[REPLACEMENT_EDITION]).toBe("DRAFT");
    expect(now[GENESIS]).toBe("PUBLISHED");
    expect(now["experience-genesis"]).toBe("PUBLISHED");
    expect(now[UNRELATED]).toBe("PUBLISHED");
    const [release] = await q("SELECT release_metadata FROM releases WHERE id=$1", [TARGET]);
    expect(release.release_metadata.abandoned).toEqual({ migration: MIGRATION, reason: "REPLACED_BY_SEQUENTIAL_RELEASE" });
    expect(release.release_metadata.releaseKey).toBe(RELEASE_KEY); // kept: the indexer matches on it
    const [edition] = await q("SELECT application_metadata FROM editions WHERE id=$1", [TARGET_EDITION]);
    expect(edition.application_metadata.abandoned).toEqual({ migration: MIGRATION, reason: "REPLACED_BY_SEQUENTIAL_RELEASE" });
    expect(edition.application_metadata.publicationAttempt.transactionHash).toBe(CREATION_TX); // audit trail kept
    const audit = await q("SELECT subject_id, chain_id, payload FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ subject_id: TARGET, payload: { reason: "REPLACED_BY_SEQUENTIAL_RELEASE", releaseContractAddress: CLONE, tokenId: TOKEN, editionCreationTransactionHash: CREATION_TX, mintedSupply: 0 } });
    expect(Number(audit[0].chain_id)).toBe(CHAIN);
  });

  it("changes no token, contract, binding, factory record, provisioning, purchase, transfer, ownership or media-asset row", async () => {
    expect(await protectedDigests()).toEqual(digestsBefore);
    expect(await q("SELECT token_id::text AS token_id FROM tokens WHERE edition_id=$1", [TARGET_EDITION])).toEqual([{ token_id: TOKEN }]);
  });

  it("re-running is a no-op, and the real runner over server/migrations applies and records it once", async () => {
    const snapshot = JSON.stringify(await q("SELECT id, status, updated_at FROM releases UNION ALL SELECT id, status, updated_at FROM editions UNION ALL SELECT id, status, updated_at FROM experiences ORDER BY 1"));
    await applyMigration();
    expect(JSON.stringify(await q("SELECT id, status, updated_at FROM releases UNION ALL SELECT id, status, updated_at FROM editions UNION ALL SELECT id, status, updated_at FROM experiences ORDER BY 1"))).toBe(snapshot);
    // What the next API start does: db:migrate over server/migrations, then again on the following start. The runner
    // reports every recorded migration; exactly 049 is new.
    const recorded = (await q("SELECT name FROM schema_migrations ORDER BY name")).map((row) => row.name);
    expect(recorded).not.toContain(MIGRATION);
    expect((await migrate({ pool, config })).applied).toEqual([...recorded, MIGRATION]);
    await migrate({ pool, config });
    expect(await q("SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    expect(JSON.stringify(await q("SELECT id, status, updated_at FROM releases UNION ALL SELECT id, status, updated_at FROM editions UNION ALL SELECT id, status, updated_at FROM experiences ORDER BY 1"))).toBe(snapshot);
    expect(await protectedDigests()).toEqual(digestsBefore);
  });

  it("the public catalog no longer serves the old release, edition or experiences; Genesis and unrelated releases stay", async () => {
    const releases = (await api.listReleases({ limit: 100, offset: 0 })).map((row) => row.id);
    const editions = (await api.listEditions({ limit: 100, offset: 0 })).map((row) => row.id);
    const experiences = (await api.listExperiences({ limit: 100, offset: 0 })).map((row) => row.id);
    expect(releases).not.toContain(TARGET);
    expect(editions).not.toContain(TARGET_EDITION);
    expect(experiences).not.toEqual(expect.arrayContaining([EXP_DEMO]));
    expect(experiences).not.toEqual(expect.arrayContaining([EXP_FULL]));
    expect(releases).toEqual(expect.arrayContaining([GENESIS, UNRELATED]));
    for (const key of [TARGET, "forgive-forget-6"]) await expect(api.getRelease({ idOrSlug: key })).rejects.toMatchObject({ status: 404, code: "RELEASE_NOT_FOUND" });
  });

  it("Studio no longer offers or opens the old release as a published sale target, and the indexer stops tracking its clone and sale", async () => {
    const catalog = await studioCatalog();
    expect(resumeOwnedRelease(catalog, TARGET)?.published).toBeFalsy();
    const choices = studioReleaseChoices(catalog).map(({ release }) => release.id);
    expect(choices).not.toContain(TARGET);
    // The replacement draft on the sequential factory is what Studio offers for the new Forgive & Forget launch.
    expect(choices).toContain(REPLACEMENT);
    expect(await trackedClones()).not.toContain(CLONE);
    const abandoned = await createIndexerStore(pool).listAbandonedReleaseContracts({ chainId: CHAIN });
    expect(abandoned).toEqual(expect.arrayContaining([{ release_contract_address: CLONE, primary_sale_address: SALE }]));
  });

  it("frees both private files for the replacement edition, which saves the full track and demo; a file another live edition holds stays reserved", async () => {
    const available = (await studio.listRegisteredMedia({ request, artistId: "voidcaller" })).protected.map((item) => item.assetId);
    expect(available).toEqual(expect.arrayContaining([DEMO_ASSET, FULL_ASSET]));
    expect(available).not.toContain(ACTIVE_ASSET);
    await expect(save(REPLACEMENT_EDITION, { fullTrack: { assetId: ACTIVE_ASSET, mediaType: "AUDIO", contentType: "audio/wav" } })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    const plans = await save(REPLACEMENT_EDITION, { fullTrack: { assetId: FULL_ASSET, mediaType: "AUDIO", contentType: "audio/wav" }, experienceAudio: { assetId: DEMO_ASSET, mediaType: "DEMO", contentType: "audio/mpeg" } });
    expect(plans).toHaveLength(2);
    const rows = await q("SELECT release_id, status, media_config, requirements FROM experiences WHERE edition_id=$1", [REPLACEMENT_EDITION]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.release_id === REPLACEMENT && row.status === "DRAFT")).toBe(true);
    expect(rows.map((row) => row.media_config.protectedMedia[0].assetId).sort()).toEqual([DEMO_ASSET, FULL_ASSET].sort());
    // The replacement's gate names its own clone and sequential token 1, never the retired token.
    for (const row of rows) expect(row.requirements).toEqual([expect.objectContaining({ contract: NEW_CLONE, tokenIds: ["1"] })]);
    expect(await digest("SELECT * FROM media_assets")).toBe(digestsBefore[0]);
  });
});
