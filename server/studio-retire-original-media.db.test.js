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

// Real Postgres (migrations 001..042, then 043): retiring the original "Forgive & Forget" release and
// reusing its private files for the replacement. Fixture rows mirror the production IDs and shapes
// the migration targets; nothing here reads or writes production. Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const MIGRATION = "043_archive_forgive_forget_original.sql";
const CHAIN = 43114;
const OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const OLD_HOLDER = "0x6a86efa012feda64b70112022487fee22e67d2fb";
const NEW_HOLDER = "0x1212121212121212121212121212121212121212";
const OLD_CONTRACT = "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103";
const NEW_CONTRACT = "0x09969f81308f28516736492ddded643abac5670d";
const SALE = "0x6ae84a51f100f10f0535a514555043ae9edf9aa3";
const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const ORIGINAL = "release-83611741-c9ee-4487-a438-b6fa844762e6";
const REPLACEMENT = "release-273f5476-0cdb-45d3-83d3-5908eb42bc6c";
const ED_DRAFT = "edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7";
const ED_PUBLISHED = "edition-6e35101c-4987-4695-ac96-d83061ef2673";
const ED_NEW = "edition-485c1e90-1ef4-4f42-98a4-0e5eab8b94e9";
const OTHER_RELEASE = "release-unrelated-active";
const OTHER_EDITION = "edition-unrelated-active";
const OLD_EXPERIENCES = [
  [ED_DRAFT, "experience-edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7-experience-audio", "asset-2deb8f1e-bb4e-4180-80c0-5fab71d57cca", "DEMO"],
  [ED_DRAFT, "experience-edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7-full-track", "asset-1463db33-e45f-44ec-bff1-2908e883eb48", "AUDIO"],
  [ED_PUBLISHED, "experience-edition-6e35101c-4987-4695-ac96-d83061ef2673-experience-audio", "asset-20e0b78d-b3b8-4455-87fc-72d2253532d8", "DEMO"],
  [ED_PUBLISHED, "experience-edition-6e35101c-4987-4695-ac96-d83061ef2673-full-track", "asset-155971a7-3d0d-4d1e-a5c1-19e83855d6a7", "AUDIO"],
];
const OLD_DEMO = "asset-20e0b78d-b3b8-4455-87fc-72d2253532d8";
const NEW_FULL = "asset-1ba76d43-cca3-4247-9e6d-f3960ed14a72";
const ACTIVE_ASSET = "asset-held-by-unrelated-active-edition";
const FORM = { productType: "DEMO", experienceTitle: "Stranger Things", experienceDescription: "", trackTitle: "Forgive & Forget", releaseTitle: "Forgive & Forget" };
const request = { requestId: "request-1", headers: {} };

describe.skipIf(!testDatabaseUrl)("Retire the original release and reuse its private files (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let studio;
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const statuses = async () => Object.fromEntries((await q("SELECT id, status FROM releases UNION ALL SELECT id, status FROM editions UNION ALL SELECT id, status FROM experiences")).map((row) => [row.id, row.status]));
  const digest = async (sql) => (await q(`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM (${sql}) t`))[0].d;
  const history = () => Promise.all([
    digest("SELECT * FROM media_assets"),
    digest("SELECT * FROM tokens"),
    digest("SELECT * FROM contracts"),
    digest("SELECT * FROM primary_purchases"),
    digest("SELECT * FROM ownership_snapshots"),
    digest("SELECT * FROM release_provisioning_requests"),
    digest("SELECT id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, version FROM experiences"),
    digest("SELECT id, release_id, title, supply, application_metadata FROM editions"),
    digest("SELECT id, artist_id, slug, title, release_metadata, published_at FROM releases"),
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
    // Entitlement follows the experience's own requirements: a wallet owns it only if it holds one of the required tokens.
    ownershipVerifier: async ({ wallet, requirements }) => ({ owns: requirements.some((r) => (holders[wallet] || []).includes(`${r.contract}:${(r.tokenIds || [])[0]}`)), state: "FINALIZED", chainId: CHAIN, watermark: "test" }),
    storage: {},
    mediaConfig: { grantTtlSeconds: 60, auditHashSecret: "test" },
  });
  const grant = (gw, wallet, experienceId) => gw.issueGrant({ request: { requestId: "r", headers: {}, wallet }, input: { wallet, experienceId, mediaType: "DEMO" } });

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_retire_media_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    const config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    const before = await mkdtemp(join(tmpdir(), "void-migrations-"));
    for (const name of (await readdir(migrationsDirectory)).filter((file) => file < MIGRATION)) await copyFile(join(migrationsDirectory, name), join(before, name));
    await migrate({ pool, config, directory: before });
    q.config = config;

    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('artist-ff','artist-ff','Voidcaller')");
    await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet) VALUES ('artist-ff',$1)", [OWNER]);
    for (const [id, slug, status] of [[ORIGINAL, "forgive-forget", "PUBLISHED"], [REPLACEMENT, "forgive-forget-2", "DRAFT"], [OTHER_RELEASE, "unrelated-active", "PUBLISHED"]]) {
      await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata, published_at) VALUES ($1,'artist-ff',$2,$2,$3,'{\"chainId\":43114}', CASE WHEN $3='PUBLISHED' THEN now() END)", [id, slug, status]);
    }
    for (const [id, release, status] of [[ED_DRAFT, ORIGINAL, "DRAFT"], [ED_PUBLISHED, ORIGINAL, "PUBLISHED"], [ED_NEW, REPLACEMENT, "DRAFT"], [OTHER_EDITION, OTHER_RELEASE, "PUBLISHED"]]) {
      await pool.query("INSERT INTO editions (id, release_id, title, status) VALUES ($1,$2,'Forgive & Forget',$3)", [id, release, status]);
    }
    const contractId = async (address) => (await q("INSERT INTO contracts (chain_id, chain_key, address, contract_type) VALUES ($1,'avalanche',$2,'ERC1155') RETURNING id", [CHAIN, address]))[0].id;
    const oldContract = await contractId(OLD_CONTRACT);
    const newContract = await contractId(NEW_CONTRACT);
    await pool.query("INSERT INTO tokens (edition_id, contract_id, token_id) VALUES ($1,$2,$4),($3,$5,$4)", [ED_PUBLISHED, oldContract, ED_NEW, TOKEN, newContract]);
    for (const [id, type] of [...OLD_EXPERIENCES.map(([, , asset, t]) => [asset, t]), [NEW_FULL, "AUDIO"], [ACTIVE_ASSET, "AUDIO"]]) {
      await pool.query("INSERT INTO media_assets (media_key, id, artist_id, media_type, storage_key, visibility, metadata) VALUES ($1,$1,'artist-ff',$2,$3,'PROTECTED','{\"byteSize\":1000}')", [id, type, `cid-${id}`]);
    }
    const requirement = (contract) => JSON.stringify([{ type: "erc1155-balance", contract, chainId: CHAIN, tokenIds: [TOKEN], minAmount: "1" }]);
    const experience = (id, release, edition, asset, type, status, contract) => pool.query(
      "INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, status) VALUES ($1,'artist-ff',$2,$3,'Experience',$4,$5,$6,$7)",
      [id, release, edition, type === "DEMO" ? "DEMO" : "AUDIO", requirement(contract), JSON.stringify({ protected: true, protectedMedia: [{ assetId: asset, mediaType: type }] }), status]);
    for (const [edition, id, asset, type] of OLD_EXPERIENCES) await experience(id, ORIGINAL, edition, asset, type, "PUBLISHED", OLD_CONTRACT);
    await experience("experience-unrelated-active", OTHER_RELEASE, OTHER_EDITION, ACTIVE_ASSET, "AUDIO", "PUBLISHED", OLD_CONTRACT);
    await pool.query("INSERT INTO primary_purchases (chain_id, sale_contract_address, token_contract_address, transaction_hash, log_index, buyer_wallet, token_id, quantity, paid_wei, artist_cut_wei, platform_cut_wei, block_number, block_hash, status) VALUES ($1,$2,$3,$4,0,$5,$6,1,100,97,3,10,$4,'FINALIZED')", [CHAIN, SALE, OLD_CONTRACT, `0x${"ab".repeat(32)}`, OLD_HOLDER, TOKEN]);
    await pool.query("INSERT INTO collectors (wallet_address) VALUES ($1)", [OLD_HOLDER]);
    await pool.query("INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,$3,$4,1,10,$5,'FINALIZED')", [CHAIN, OLD_CONTRACT, TOKEN, OLD_HOLDER, `0x${"cd".repeat(32)}`]);
    await pool.query("INSERT INTO release_provisioning_requests (release_id, chain_id, release_key, artist_wallet, factory_address, authorization_digest, expected_parameters, transaction_hash, state) VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,'RECONCILING')", [REPLACEMENT, CHAIN, `0x${"b0".repeat(32)}`, OWNER, "0xe744d58fa8138042f5f00a28d39f89081539c19b", `0x${"11".repeat(32)}`, `0x${"2f".repeat(32)}`]);

    studio = new ArtistStudioService({ db: pool, repository: createPersistenceRepository(pool), authenticator: async () => ({ wallet: OWNER }), logger: { info() {}, error() {} } });
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  let historyBefore;
  let untouchedBefore;

  it("before retirement, a file used by the original's published edition is rejected for the replacement, with an actionable error", async () => {
    historyBefore = await history();
    untouchedBefore = (await q("SELECT id, status, updated_at FROM releases WHERE id <> $1 UNION ALL SELECT id, status, updated_at FROM editions WHERE release_id <> $1 UNION ALL SELECT id, status, updated_at FROM experiences WHERE release_id IS DISTINCT FROM $1", [ORIGINAL])).map((row) => `${row.id}|${row.status}|${row.updated_at.toISOString()}`).sort();
    const demo = { assetId: OLD_DEMO, mediaType: "DEMO", contentType: "audio/mpeg" };
    await expect(save(ED_NEW, { experienceAudio: demo })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE", message: expect.stringMatching(/active experience of a different edition.*different file.*retire the other edition/s) });
    expect(await q("SELECT id FROM experiences WHERE edition_id=$1", [ED_NEW])).toHaveLength(0); // nothing half-saved
  });

  it("retires exactly the original release, its editions and its experiences, and nothing else", async () => {
    await applyMigration();
    const now = await statuses();
    expect(now[ORIGINAL]).toBe("ARCHIVED");
    expect(now[ED_DRAFT]).toBe("ARCHIVED");
    expect(now[ED_PUBLISHED]).toBe("ARCHIVED");
    for (const [, id] of OLD_EXPERIENCES) expect(now[id]).toBe("ARCHIVED");
    // The replacement and an unrelated active release are unchanged, down to updated_at.
    expect(now[REPLACEMENT]).toBe("DRAFT");
    expect(now[ED_NEW]).toBe("DRAFT");
    expect(now[OTHER_RELEASE]).toBe("PUBLISHED");
    expect(now[OTHER_EDITION]).toBe("PUBLISHED");
    expect(now["experience-unrelated-active"]).toBe("PUBLISHED");
    const untouchedAfter = (await q("SELECT id, status, updated_at FROM releases WHERE id <> $1 UNION ALL SELECT id, status, updated_at FROM editions WHERE release_id <> $1 UNION ALL SELECT id, status, updated_at FROM experiences WHERE release_id IS DISTINCT FROM $1", [ORIGINAL])).map((row) => `${row.id}|${row.status}|${row.updated_at.toISOString()}`).sort();
    expect(untouchedAfter).toEqual(untouchedBefore);
    const audit = await q("SELECT subject_id, payload FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION'");
    expect(audit).toHaveLength(1);
    expect(audit[0].subject_id).toBe(ORIGINAL);
    expect(audit[0].payload.replacementReleaseId).toBe(REPLACEMENT);
  });

  it("keeps every media record, experience association, token, contract, purchase, ownership row and the provisioning request", async () => {
    expect(await history()).toEqual(historyBefore);
    expect(await q("SELECT count(*)::int AS n FROM experiences WHERE release_id=$1", [ORIGINAL])).toEqual([{ n: 4 }]);
    expect(await q("SELECT count(*)::int AS n FROM primary_purchases WHERE status='FINALIZED'")).toEqual([{ n: 1 }]);
    expect(await q("SELECT state, transaction_hash FROM release_provisioning_requests WHERE release_id=$1", [REPLACEMENT])).toEqual([{ state: "RECONCILING", transaction_hash: `0x${"2f".repeat(32)}` }]);
    const published = await q("SELECT published_at FROM releases WHERE id=$1", [ORIGINAL]);
    expect(published[0].published_at).not.toBeNull(); // publication history is kept
  });

  it("re-running the migration is a no-op, and the migration runner records it once without error", async () => {
    const snapshot = JSON.stringify(await q("SELECT id, status, updated_at FROM experiences ORDER BY id"));
    await applyMigration();
    expect(JSON.stringify(await q("SELECT id, status, updated_at FROM experiences ORDER BY id"))).toBe(snapshot);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    const result = await migrate({ pool, config: q.config });
    expect(result.applied).toContain(MIGRATION);
    await migrate({ pool, config: q.config }); // second run: checksum matches, nothing applied twice
    expect(await q("SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1", [MIGRATION])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION' AND payload->>'migration'=$1", [MIGRATION])).toEqual([{ n: 1 }]);
  });

  it("lists files held only by archived experiences as available, and never a file an active experience holds", async () => {
    const ids = (await studio.listRegisteredMedia({ request, artistId: "artist-ff" })).protected.map((item) => item.assetId);
    expect(ids).toContain(OLD_DEMO);
    expect(ids).toContain(NEW_FULL);
    expect(ids).not.toContain(ACTIVE_ASSET);
  });

  it("still rejects a file held by an active edition, and a failed save leaves no experience rows", async () => {
    const before = await q("SELECT id FROM experiences ORDER BY id");
    await expect(save(ED_NEW, { fullTrack: { assetId: ACTIVE_ASSET, mediaType: "AUDIO", contentType: "audio/wav" } })).rejects.toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    // Demo first (free after retirement), then the full track that conflicts: the second save fails; only the first stays.
    await expect(save(ED_NEW, { fullTrack: { assetId: ACTIVE_ASSET, mediaType: "AUDIO", contentType: "audio/wav" }, experienceAudio: { assetId: OLD_DEMO, mediaType: "DEMO", contentType: "audio/mpeg" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_IN_USE" });
    const rows = await q("SELECT id, media_config FROM experiences WHERE edition_id=$1", [ED_NEW]);
    expect(rows).toHaveLength(1); // the demo save committed on its own; the failed full-track save wrote nothing
    expect(JSON.stringify(rows[0].media_config)).toContain(OLD_DEMO);
    expect(JSON.stringify(rows[0].media_config)).not.toContain(ACTIVE_ASSET);
    await pool.query("DELETE FROM experiences WHERE edition_id=$1", [ED_NEW]); // reset the scratch fixture only
    expect((await q("SELECT id FROM experiences ORDER BY id")).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  it("lets the replacement use its own full track and the demo the original had, without an on-chain action", async () => {
    const plans = await save(ED_NEW, { fullTrack: { assetId: NEW_FULL, mediaType: "AUDIO", contentType: "audio/wav" }, experienceAudio: { assetId: OLD_DEMO, mediaType: "DEMO", contentType: "audio/mpeg" } });
    expect(plans).toHaveLength(2);
    const rows = await q("SELECT id, status, edition_id, media_config FROM experiences WHERE edition_id=$1 ORDER BY id", [ED_NEW]);
    expect(rows.map((r) => r.status)).toEqual(["DRAFT", "DRAFT"]);
    expect(rows.flatMap((r) => r.media_config.protectedMedia.map((m) => m.assetId)).sort()).toEqual([OLD_DEMO, NEW_FULL].sort());
    // The original's archived association to the same file is untouched.
    const old = await q("SELECT status, media_config FROM experiences WHERE id=$1", [OLD_EXPERIENCES[2][1]]);
    expect(old[0].status).toBe("ARCHIVED");
    expect(old[0].media_config.protectedMedia[0].assetId).toBe(OLD_DEMO);
    // Saving again is idempotent: still two experiences, no extra rows.
    await save(ED_NEW, { fullTrack: { assetId: NEW_FULL, mediaType: "AUDIO", contentType: "audio/wav" }, experienceAudio: { assetId: OLD_DEMO, mediaType: "DEMO", contentType: "audio/mpeg" } });
    expect(await q("SELECT count(*)::int AS n FROM experiences WHERE edition_id=$1", [ED_NEW])).toEqual([{ n: 2 }]);
    // Nothing in the provisioning request or contracts moved.
    expect(await q("SELECT state FROM release_provisioning_requests")).toEqual([{ state: "RECONCILING" }]);
    expect(await digest("SELECT * FROM contracts")).toBe(historyBefore[2]);
  });

  it("keeps access separated by edition: archived experiences are not served, and a holder of one edition's token cannot open the other's", async () => {
    const holders = { [OLD_HOLDER]: [`${OLD_CONTRACT}:${TOKEN}`], [NEW_HOLDER]: [`${NEW_CONTRACT}:${TOKEN}`] };
    const gw = gateway(holders);
    const demoOld = OLD_EXPERIENCES[2][1];
    const demoNew = (await q("SELECT id FROM experiences WHERE edition_id=$1 AND media_config::text LIKE $2", [ED_NEW, `%${OLD_DEMO}%`]))[0].id;
    // Retired edition: its own holder no longer gets the file (accepted product decision), and the new holder never does.
    await expect(grant(gw, OLD_HOLDER, demoOld)).rejects.toMatchObject({ status: 404, code: "EXPERIENCE_NOT_FOUND" });
    await expect(grant(gw, NEW_HOLDER, demoOld)).rejects.toMatchObject({ status: 404, code: "EXPERIENCE_NOT_FOUND" });
    // The replacement is served only once it is published; its requirements name only the new contract's token.
    await pool.query("UPDATE editions SET status='PUBLISHED' WHERE id=$1", [ED_NEW]);
    await pool.query("UPDATE experiences SET status='PUBLISHED', requirements=$2 WHERE id=$1", [demoNew, JSON.stringify([{ type: "erc1155-balance", contract: NEW_CONTRACT, chainId: CHAIN, tokenIds: [TOKEN], minAmount: "1" }])]);
    await expect(grant(gw, OLD_HOLDER, demoNew)).rejects.toMatchObject({ status: 403, code: "EXPERIENCE_ENTITLEMENT_REQUIRED" });
    await expect(grant(gw, NEW_HOLDER, demoNew)).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it("does not let an archived experience be re-published while the replacement holds its file", async () => {
    const experience = OLD_EXPERIENCES[2][1];
    const release = { id: ORIGINAL, artist_id: "artist-ff" };
    const [row] = await q("SELECT id, artist_id, release_id, edition_id, title, description, experience_type, requirements, media_config, version, status FROM experiences WHERE id=$1", [experience]);
    await pool.query("UPDATE experiences SET status='DRAFT' WHERE id=$1", [experience]); // simulates a reversal that would put it back in play
    await studio.publishExperience(release, { ...row, status: "DRAFT" });
    expect((await q("SELECT status FROM experiences WHERE id=$1", [experience]))[0].status).toBe("DRAFT"); // blocked: the replacement's active experience holds the file
  });
});
