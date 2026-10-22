import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate, migrationBody, migrationsDirectory } from "./migrate.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { createPersistenceRepository } from "./repositories.js";
import { ArtistStudioService } from "./studio-service.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";
import { planCatalogExperiences } from "../src/lib/studio-experiences.js";
import { mapPublishedCatalog } from "../src/lib/catalog-source.js";
import { mapReleaseBindings } from "../src/lib/sale-earnings.js";
import { studioReleaseChoices } from "../src/lib/studio-release-choices.js";

// Real Postgres (migrations 001..043, then 044): retiring the EP-typed replacement "Forgive & Forget" so the
// already-deployed Single can attach the same private files. Fixture rows mirror the production IDs and shapes
// the migration targets (read-only inspection, 2026-10-22); nothing here reads or writes production.
// Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const MIGRATION = "044_retire_ep_replacement_forgive_forget.sql";
const CHAIN = 43114;
const OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const EP_HOLDER = "0x1212121212121212121212121212121212121212";
const SINGLE_HOLDER = "0x3434343434343434343434343434343434343434";
const FACTORY = "0xe744d58fa8138042f5f00a28d39f89081539c19b";
const OLD_CONTRACT = "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103";
const EP_CONTRACT = "0x09969f81308f28516736492ddded643abac5670d";
const EP_SALE = "0x3b4cb323693894929c4b7a9f1747e7390219023e";
const EP_ANCHOR = "0x775980c1b75e5553f71a1a17db72d6b61c85dfad";
const SINGLE_CONTRACT = "0x8192cc13caec165afd802af691f952573bb3d817";
const SINGLE_SALE = "0x1091af3886a43896d5804f785782db911c308d81";
const SINGLE_ANCHOR = "0xd07ae2b67528958303e1f1130d97b2e433aff24e";
const IMPLEMENTATION = "0x36c5d31e9a8e9b4dc9f8cb4b7202c70b3e30734d";
const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";

const ORIGINAL = "release-83611741-c9ee-4487-a438-b6fa844762e6";
const ORIGINAL_EDITIONS = ["edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7", "edition-6e35101c-4987-4695-ac96-d83061ef2673"];
const RETIRED = "release-273f5476-0cdb-45d3-83d3-5908eb42bc6c";
const ED_811 = "edition-81122aa5-c0b8-446b-8dec-09b061ebca60";
const ED_485 = "edition-485c1e90-1ef4-4f42-98a4-0e5eab8b94e9";
const EXP_DEMO = "experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-experience-audio";
const EXP_FULL = "experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-full-track";
const SINGLE = "release-cd9c689c-8b90-41ee-b4e4-0124a63d6819";
const ED_SINGLE = "edition-single-forgive-forget";
const VOIDCALLER = "voidcaller-legacy-genesis";
const VOIDCALLER_EDITION = "voidcaller-legacy-edition";
const DEMO_ASSET = "asset-20e0b78d-b3b8-4455-87fc-72d2253532d8"; // stronger_thongs.mp3, shared by bytes with the original's demo
const FULL_ASSET = "asset-2b4cb3b6-f83c-4269-89de-a696d7486022"; // ApolloMatch.wav
const ORIGINAL_FULL_ASSET = "asset-155971a7-3d0d-4d1e-a5c1-19e83855d6a7";
const ACTIVE_ASSET = "asset-held-by-voidcaller";
const TARGET_IDS = [RETIRED, ED_811, ED_485, EXP_DEMO, EXP_FULL].sort();
const FORM = { productType: "DEMO", experienceTitle: "Stranger Things", experienceDescription: "", trackTitle: "Forgive & Forget", releaseTitle: "Forgive & Forget" };
const request = { requestId: "request-1", headers: {} };
// PR #258 lets the picker keep a same-title draft whose release contract is deployed (releaseBindings). Until it is on main
// the picker test below is skipped, and production must not rely on it.
const pickerKeepsDeployedDraft = (() => {
  const artists = [{ id: "a", name: "A" }];
  const releases = [{ id: "old", artistId: "a", title: "T", status: "archived" }, { id: "new", artistId: "a", title: "T", status: "draft" }];
  const releaseBindings = [{ releaseId: "new", releaseContractAddress: "0x8192cc13caec165afd802af691f952573bb3d817" }];
  return studioReleaseChoices({ artists, releases, releaseBindings }).some(({ release }) => release.id === "new");
})();

describe.skipIf(!testDatabaseUrl)("Retire the EP replacement and finish the Single (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let studio;
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const statuses = async () => Object.fromEntries((await q("SELECT id, status FROM releases UNION ALL SELECT id, status FROM editions UNION ALL SELECT id, status FROM experiences")).map((row) => [row.id, row.status]));
  const digest = async (sql) => (await q(`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM (${sql}) t`))[0].d;
  const protectedDigests = () => Promise.all([
    digest("SELECT * FROM media_assets"),
    digest("SELECT * FROM tokens"),
    digest("SELECT * FROM contracts"),
    digest("SELECT * FROM release_contracts"),
    digest("SELECT * FROM release_provisioning_requests"),
    digest("SELECT * FROM primary_purchases"),
    digest("SELECT * FROM ownership_snapshots"),
    digest("SELECT * FROM artists"),
    digest("SELECT * FROM artist_owners"),
    // Everything about the original, the Single and VOIDCALLER, including updated_at.
    digest(`SELECT * FROM releases WHERE id IN ('${ORIGINAL}','${SINGLE}','${VOIDCALLER}')`),
    digest(`SELECT * FROM editions WHERE release_id IN ('${ORIGINAL}','${SINGLE}','${VOIDCALLER}')`),
    digest(`SELECT * FROM experiences WHERE release_id IN ('${ORIGINAL}','${SINGLE}','${VOIDCALLER}')`),
    // The retired rows themselves keep every column except status and updated_at.
    digest(`SELECT id, artist_id, slug, title, description, release_metadata, published_at FROM releases WHERE id='${RETIRED}'`),
    digest(`SELECT id, release_id, contract_id, title, supply, tier, application_metadata FROM editions WHERE release_id='${RETIRED}'`),
    digest(`SELECT id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, version FROM experiences WHERE release_id='${RETIRED}'`),
  ]);
  const applyMigration = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migrationBody(await readFile(join(migrationsDirectory, MIGRATION), "utf8"), MIGRATION));
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  const save = async (editionId, files) => {
    const plans = planCatalogExperiences({ ...FORM, editionId, ...files });
    for (const plan of plans) await studio.createExperience({ request, editionId, input: plan.payload });
    return plans;
  };
  const gateway = (holders) => new ProtectedMediaGateway({
    db: pool,
    repository: createPersistenceRepository(pool),
    authenticator: async (req) => ({ wallet: req.wallet }),
    ownershipVerifier: async ({ wallet, requirements }) => ({ owns: requirements.some((r) => (holders[wallet] || []).includes(`${r.contract}:${(r.tokenIds || [])[0]}`)), state: "FINALIZED", chainId: CHAIN, watermark: "test" }),
    storage: {},
    mediaConfig: { grantTtlSeconds: 60, auditHashSecret: "test" },
  });
  const grant = (gw, wallet, experienceId) => gw.issueGrant({ request: { requestId: "r", headers: {}, wallet }, input: { wallet, experienceId, mediaType: "DEMO" } });
  const requirement = (contract) => JSON.stringify([{ type: "erc1155-balance", contract, chainId: CHAIN, tokenIds: [TOKEN], minAmount: "1" }]);

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_retire_ep_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    const config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    const before = await mkdtemp(join(tmpdir(), "void-migrations-"));
    for (const name of (await readdir(migrationsDirectory)).filter((file) => file < MIGRATION)) await copyFile(join(migrationsDirectory, name), join(before, name));
    await migrate({ pool, config, directory: before });
    q.config = config;

    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('voidcaller','voidcaller','Voidcaller') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet) VALUES ('voidcaller',$1) ON CONFLICT DO NOTHING", [OWNER]);
    // Production state after 043: the original is archived; the replacement and the Single are drafts.
    const releases = [
      [ORIGINAL, "forgive-forget", "Forgive & Forget", "ARCHIVED", "SINGLE"],
      [RETIRED, "forgive-forget-2", "Forgive & Forget", "DRAFT", "EP"],
      [SINGLE, "forgive-and-forget", "Forgive and Forget", "DRAFT", "SINGLE"],
      [VOIDCALLER, "voidcaller-legacy-genesis", "VOIDCALLER", "PUBLISHED", "EP"],
    ];
    for (const [id, slug, title, status, type] of releases) {
      await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata, published_at) VALUES ($1,'voidcaller',$2,$3,$4,$5, CASE WHEN $4='PUBLISHED' THEN now() END) ON CONFLICT (id) DO NOTHING", [id, slug, title, status, JSON.stringify({ chainId: CHAIN, releaseType: type, publicationArchitecture: "release-per-contract" })]);
    }
    const editions = [
      [ORIGINAL_EDITIONS[0], ORIGINAL, "ARCHIVED", 25], [ORIGINAL_EDITIONS[1], ORIGINAL, "ARCHIVED", 0],
      [ED_485, RETIRED, "DRAFT", 25], [ED_811, RETIRED, "DRAFT", 0],
      [VOIDCALLER_EDITION, VOIDCALLER, "PUBLISHED", 0],
    ];
    for (const [id, release, status, supply] of editions) await pool.query("INSERT INTO editions (id, release_id, title, status, supply) VALUES ($1,$2,'Forgive & Forget',$3,$4) ON CONFLICT (id) DO NOTHING", [id, release, status, supply]);
    const contractId = async (address, type = "ERC1155") => (await q("INSERT INTO contracts (chain_id, chain_key, address, contract_type) VALUES ($1,'avalanche',$2,$3) RETURNING id", [CHAIN, address, type]))[0].id;
    const ids = {};
    for (const [key, address] of Object.entries({ OLD_CONTRACT, EP_CONTRACT, EP_SALE, EP_ANCHOR, SINGLE_CONTRACT, SINGLE_SALE, SINGLE_ANCHOR, FACTORY })) ids[key] = await contractId(address, key === "FACTORY" ? "OTHER" : "ERC1155");
    // The same token ID exists on two contracts (the token ID derives from the edition slug only).
    await pool.query("INSERT INTO tokens (edition_id, contract_id, token_id) VALUES ($1,$2,$4),($3,$5,$4)", [ORIGINAL_EDITIONS[1], ids.OLD_CONTRACT, ED_811, TOKEN, ids.EP_CONTRACT]);
    await pool.query("INSERT INTO editions (id, release_id, title, status, supply, contract_id) VALUES ($1,$2,'Forgive & Forget','DRAFT',0,$3)", [ED_SINGLE, SINGLE, ids.SINGLE_CONTRACT]);
    // createEdition stores the edition's deterministic token row; the Single's edition has one on its own contract.
    await pool.query("INSERT INTO tokens (edition_id, contract_id, token_id) VALUES ($1,$2,$3)", [ED_SINGLE, ids.SINGLE_CONTRACT, TOKEN]);
    const binding = (release, contract, sale, anchor, key) => pool.query(
      "INSERT INTO release_contracts (release_id, chain_id, release_contract_id, factory_contract_id, primary_sale_contract_id, provenance_anchor_contract_id, release_key, artist_wallet, implementation_address, implementation_version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2,'DEPLOYED')",
      [release, CHAIN, ids[contract], ids.FACTORY, ids[sale], ids[anchor], `0x${key.repeat(32)}`, OWNER, IMPLEMENTATION]);
    await binding(RETIRED, "EP_CONTRACT", "EP_SALE", "EP_ANCHOR", "b0");
    // The Single as it will be once its factory transaction is reconciled (binding present, no editions yet).
    await binding(SINGLE, "SINGLE_CONTRACT", "SINGLE_SALE", "SINGLE_ANCHOR", "63");
    await pool.query("UPDATE editions SET contract_id=$1 WHERE id=$2", [ids.EP_CONTRACT, ED_811]);
    for (const [id, type] of [[DEMO_ASSET, "DEMO"], [FULL_ASSET, "AUDIO"], [ORIGINAL_FULL_ASSET, "AUDIO"], [ACTIVE_ASSET, "AUDIO"]]) {
      await pool.query("INSERT INTO media_assets (media_key, id, artist_id, media_type, storage_key, visibility, metadata) VALUES ($1,$1,'voidcaller',$2,$3,'PROTECTED','{\"byteSize\":1000}')", [id, type, `cid-${id}`]);
    }
    const experience = (id, release, edition, asset, type, status, contract, primary) => pool.query(
      "INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, status) VALUES ($1,'voidcaller',$2,$3,'Experience',$4,$5,$6,$7)",
      [id, release, edition, type === "DEMO" ? "DEMO" : "AUDIO", requirement(contract), JSON.stringify({ protected: true, primary, protectedMedia: [{ assetId: asset, mediaType: type }] }), status]);
    await experience("experience-original-demo", ORIGINAL, ORIGINAL_EDITIONS[1], DEMO_ASSET, "DEMO", "ARCHIVED", OLD_CONTRACT, false);
    await experience("experience-original-full", ORIGINAL, ORIGINAL_EDITIONS[1], ORIGINAL_FULL_ASSET, "AUDIO", "ARCHIVED", OLD_CONTRACT, true);
    await experience(EXP_DEMO, RETIRED, ED_811, DEMO_ASSET, "DEMO", "DRAFT", EP_CONTRACT, false);
    await experience(EXP_FULL, RETIRED, ED_811, FULL_ASSET, "AUDIO", "DRAFT", EP_CONTRACT, true);
    await experience("experience-voidcaller", VOIDCALLER, VOIDCALLER_EDITION, ACTIVE_ASSET, "AUDIO", "PUBLISHED", OLD_CONTRACT, true);
    await pool.query("INSERT INTO primary_purchases (chain_id, sale_contract_address, token_contract_address, transaction_hash, log_index, buyer_wallet, token_id, quantity, paid_wei, artist_cut_wei, platform_cut_wei, block_number, block_hash, status) VALUES ($1,$2,$3,$4,0,$5,$6,1,100,97,3,10,$4,'FINALIZED')", [CHAIN, EP_SALE, OLD_CONTRACT, `0x${"ab".repeat(32)}`, "0x6a86efa012feda64b70112022487fee22e67d2fb", TOKEN]);
    await pool.query("INSERT INTO collectors (wallet_address) VALUES ('0x6a86efa012feda64b70112022487fee22e67d2fb')");
    await pool.query("INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,$3,'0x6a86efa012feda64b70112022487fee22e67d2fb',1,10,$4,'FINALIZED')", [CHAIN, OLD_CONTRACT, TOKEN, `0x${"cd".repeat(32)}`]);
    const provisioning = (release, key, state, hash) => pool.query("INSERT INTO release_provisioning_requests (release_id, chain_id, release_key, artist_wallet, factory_address, authorization_digest, expected_parameters, transaction_hash, state) VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8)", [release, CHAIN, `0x${key.repeat(32)}`, OWNER, FACTORY, `0x${key.repeat(32)}`, `0x${hash.repeat(32)}`, state]);
    await provisioning(RETIRED, "b0", "CONFIRMED", "2f");
    await provisioning(SINGLE, "63", "RECONCILING", "a6");

    studio = new ArtistStudioService({ db: pool, repository: createPersistenceRepository(pool), authenticator: async () => ({ wallet: OWNER }), logger: { info() {}, error() {} } });
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  let digestsBefore;
  let statusBefore;

  it("before retirement, the replacement's draft experiences reserve both files, so the Single cannot attach them", async () => {
    digestsBefore = await protectedDigests();
    statusBefore = await statuses();
    await expect(save(ED_SINGLE, { experienceAudio: { assetId: DEMO_ASSET, mediaType: "DEMO", contentType: "audio/mpeg" } })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    await expect(save(ED_SINGLE, { fullTrack: { assetId: FULL_ASSET, mediaType: "AUDIO", contentType: "audio/wav" } })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    expect(await q("SELECT id FROM experiences WHERE edition_id=$1", [ED_SINGLE])).toHaveLength(0); // nothing half-saved
  });

  it("archives exactly one release, two editions and two experiences, by ID, and nothing else", async () => {
    await applyMigration();
    const now = await statuses();
    const changed = Object.keys(now).filter((id) => now[id] !== statusBefore[id]).sort();
    expect(changed).toEqual(TARGET_IDS);
    expect(changed).toHaveLength(5);
    for (const id of TARGET_IDS) expect(now[id]).toBe("ARCHIVED");
    expect(Object.keys(now)).toHaveLength(Object.keys(statusBefore).length); // nothing created or deleted
    expect(await q("SELECT count(*)::int AS n FROM releases WHERE status='ARCHIVED' AND id=ANY($1)", [[RETIRED]])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM editions WHERE status='ARCHIVED' AND id=ANY($1)", [[ED_811, ED_485]])).toEqual([{ n: 2 }]);
    expect(await q("SELECT count(*)::int AS n FROM experiences WHERE status='ARCHIVED' AND id=ANY($1)", [[EXP_DEMO, EXP_FULL]])).toEqual([{ n: 2 }]);
    // The original stays exactly as 043 left it; the Single and VOIDCALLER are untouched.
    expect(now[ORIGINAL]).toBe("ARCHIVED");
    expect(now[SINGLE]).toBe("DRAFT");
    expect(now[ED_SINGLE]).toBe("DRAFT");
    expect(now[VOIDCALLER]).toBe("PUBLISHED");
    expect(now[VOIDCALLER_EDITION]).toBe("PUBLISHED");
    expect(now["experience-voidcaller"]).toBe("PUBLISHED");
    const audit = await q("SELECT subject_id, payload FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION]);
    expect(audit).toHaveLength(1);
    expect(audit[0].subject_id).toBe(RETIRED);
    expect(audit[0].payload.singleReleaseId).toBe(SINGLE);
  });

  it("changes no token, contract, binding, provisioning request, purchase, ownership or media-asset row, and no legacy, Single or VOIDCALLER column", async () => {
    expect(await protectedDigests()).toEqual(digestsBefore);
    expect(await q("SELECT state FROM release_provisioning_requests WHERE release_id=$1", [RETIRED])).toEqual([{ state: "CONFIRMED" }]);
    expect(await q("SELECT state FROM release_provisioning_requests WHERE release_id=$1", [SINGLE])).toEqual([{ state: "RECONCILING" }]);
    expect(await q("SELECT count(*)::int AS n FROM media_assets")).toEqual([{ n: 4 }]); // content-addressed assets: no new or duplicate rows
    expect(await q("SELECT count(*)::int AS n FROM tokens WHERE token_id=$1", [TOKEN])).toEqual([{ n: 3 }]);
    expect(await q("SELECT count(*)::int AS n FROM experiences WHERE release_id=$1", [ORIGINAL])).toEqual([{ n: 2 }]);
  });

  it("re-running the migration is a no-op, and the runner records it once", async () => {
    const snapshot = JSON.stringify(await q("SELECT id, status, updated_at FROM experiences ORDER BY id"));
    await applyMigration();
    expect(JSON.stringify(await q("SELECT id, status, updated_at FROM experiences ORDER BY id"))).toBe(snapshot);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    // Migrate only through 044: later migrations (045 retires the Single this suite keeps as a DRAFT fixture) have their own tests.
    const through = await mkdtemp(join(tmpdir(), "void-migrations-through-"));
    for (const name of (await readdir(migrationsDirectory)).filter((file) => file <= MIGRATION)) await copyFile(join(migrationsDirectory, name), join(through, name));
    const result = await migrate({ pool, config: q.config, directory: through });
    expect(result.applied).toContain(MIGRATION);
    await migrate({ pool, config: q.config, directory: through });
    expect(await q("SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    expect(await protectedDigests()).toEqual(digestsBefore);
  });

  it("lists both files as available, and never a file an active experience holds", async () => {
    const ids = (await studio.listRegisteredMedia({ request, artistId: "voidcaller" })).protected.map((item) => item.assetId);
    expect(ids).toContain(DEMO_ASSET);
    expect(ids).toContain(FULL_ASSET);
    expect(ids).not.toContain(ACTIVE_ASSET);
  });

  it("still rejects a file an active edition holds", async () => {
    await expect(save(ED_SINGLE, { fullTrack: { assetId: ACTIVE_ASSET, mediaType: "AUDIO", contentType: "audio/wav" } })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    expect(await q("SELECT id FROM experiences WHERE edition_id=$1", [ED_SINGLE])).toHaveLength(0);
  });

  it("lets the Single save the full track (primary) and the demo as two distinct experiences of one edition, reusing the stored files", async () => {
    const plans = await save(ED_SINGLE, { fullTrack: { assetId: FULL_ASSET, mediaType: "AUDIO", contentType: "audio/wav" }, experienceAudio: { assetId: DEMO_ASSET, mediaType: "DEMO", contentType: "audio/mpeg" } });
    expect(plans).toHaveLength(2);
    const rows = await q("SELECT id, status, edition_id, release_id, experience_type, media_config FROM experiences WHERE edition_id=$1 ORDER BY id", [ED_SINGLE]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.release_id === SINGLE && row.status === "DRAFT")).toBe(true);
    expect(rows.map((row) => row.media_config.protectedMedia[0].assetId).sort()).toEqual([DEMO_ASSET, FULL_ASSET].sort());
    expect(rows.filter((row) => row.media_config.primary === true)).toHaveLength(1); // one primary song; the demo is not a second primary
    expect(rows.find((row) => row.media_config.primary === true).media_config.protectedMedia[0].assetId).toBe(FULL_ASSET);
    // Saving again is idempotent, and no media-asset or other protected row moved.
    await save(ED_SINGLE, { fullTrack: { assetId: FULL_ASSET, mediaType: "AUDIO", contentType: "audio/wav" }, experienceAudio: { assetId: DEMO_ASSET, mediaType: "DEMO", contentType: "audio/mpeg" } });
    expect(await q("SELECT count(*)::int AS n FROM experiences WHERE edition_id=$1", [ED_SINGLE])).toEqual([{ n: 2 }]);
    expect(await digest("SELECT * FROM media_assets")).toBe(digestsBefore[0]);
    expect(await digest("SELECT * FROM release_provisioning_requests")).toBe(digestsBefore[4]);
  });

  it("keeps access separated: archived experiences are not served, and only a holder of the Single's token opens the Single's demo", async () => {
    const gw = gateway({ [EP_HOLDER]: [`${EP_CONTRACT}:${TOKEN}`], [SINGLE_HOLDER]: [`${SINGLE_CONTRACT}:${TOKEN}`] });
    await expect(grant(gw, EP_HOLDER, EXP_DEMO)).rejects.toMatchObject({ status: 404, code: "EXPERIENCE_NOT_FOUND" }); // retired experience is not served
    const demo = (await q("SELECT id FROM experiences WHERE edition_id=$1 AND media_config::text LIKE $2", [ED_SINGLE, `%${DEMO_ASSET}%`]))[0].id;
    // Before publication nothing about the Single is served.
    await expect(grant(gw, SINGLE_HOLDER, demo)).rejects.toMatchObject({ status: 404 });
    // After the owner publishes (simulated here), the demo's requirement names the Single's own contract token.
    await pool.query("UPDATE editions SET status='PUBLISHED' WHERE id=$1", [ED_SINGLE]);
    await pool.query("UPDATE experiences SET status='PUBLISHED', requirements=$2 WHERE edition_id=$1", [ED_SINGLE, requirement(SINGLE_CONTRACT)]);
    await expect(grant(gw, EP_HOLDER, demo)).rejects.toMatchObject({ status: 403, code: "EXPERIENCE_ENTITLEMENT_REQUIRED" });
    await expect(grant(gw, SINGLE_HOLDER, demo)).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it.skipIf(!pickerKeepsDeployedDraft)("keeps the deployed Single selectable in Studio after the replacement is archived (needs PR #258's deployed-binding rule)", async () => {
    await pool.query("UPDATE releases SET title='Forgive & Forget' WHERE id=$1", [SINGLE]); // the owner's intended title; scratch fixture only
    const payload = await studio.listCatalog({ request });
    const catalog = { ...mapPublishedCatalog(payload), releaseBindings: mapReleaseBindings(payload.releaseBindings) };
    const choices = studioReleaseChoices(catalog).map(({ release }) => release.id);
    expect(choices).toContain(SINGLE);
    expect(choices).toContain(VOIDCALLER);
    expect(choices).not.toContain(ORIGINAL);
    expect(choices).not.toContain(RETIRED);
    // The Single is the only same-title card; it is offered because its release contract is deployed.
    expect(choices.filter((id) => [ORIGINAL, RETIRED, SINGLE].includes(id))).toEqual([SINGLE]);
    // Without its binding (an unreconciled Single) the retired-title rule hides it, so reconciliation must come first.
    const unbound = studioReleaseChoices({ ...catalog, releaseBindings: [] }).map(({ release }) => release.id);
    expect(unbound).not.toContain(SINGLE);
    // History stays readable: the full catalog still returns the archived original and the retired replacement.
    expect(payload.releases.map((row) => row.id)).toEqual(expect.arrayContaining([ORIGINAL, RETIRED, SINGLE, VOIDCALLER]));
  });
});
