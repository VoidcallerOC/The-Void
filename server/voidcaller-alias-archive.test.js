import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { listMigrations, migrate, migrationsDirectory } from "./migrate.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Validates the one-time operator SQL in scripts/ops/voidcaller-alias-archive against a
// scratch database that reproduces the production dependency state. The SQL lives
// outside server/migrations so it never runs on deploy.

const OPS = join(import.meta.dirname, "..", "scripts", "ops", "voidcaller-alias-archive");
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const E2E = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const CERTIFIED = "0x82b26da27136935454bdf1e40801190b521b82e5";
const MARKETPLACE = "0x982b28352fd612fe934c5e1ad8fea399689190d2";
const SALE = "0xcc26cd6d6dc25654652d1fbb64db5f61e20f60f1";
const CERT_TOKEN = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
const E2E_TOKEN = "69621777096996404494569967715110965261109496187347335164928263396549073080909";
const VC7 = "artist-cf2c2990-b0b0-4933-bcac-556cf55c0724";
const TARGETS = [
  ["artist-bd29734b-a262-4922-93e1-b390a0c7a142", "voidcaller-2"],
  ["artist-78155b6c-f6b4-4bff-adb5-2d6d123d6d36", "voidcaller-3"],
  ["artist-f67c333a-05ab-4d27-8eb4-98c713a6d6fb", "voidcaller-4"],
  ["artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495", "voidcaller-5"],
  ["artist-f6be711f-c5f1-43de-bba3-a085950ae1d1", "voidcaller-6"],
  ["artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3", "voidcaller-8"],
];
const TARGET_IDS = TARGETS.map(([id]) => id);
const hex = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;

describe.skipIf(!testDatabaseUrl)("voidcaller alias archive operator SQL", () => {
  let adminPool;
  let pool;
  let dbName;
  const sql = {};

  async function run(file) {
    const client = await pool.connect();
    const notices = [];
    client.on("notice", (notice) => notices.push(notice.message));
    try {
      const result = await client.query(sql[file]);
      const rows = (Array.isArray(result) ? result : [result]).filter((part) => part.command === "SELECT").at(-1)?.rows ?? [];
      return { rows, notices };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Every row outside artists that the archive must never touch.
  async function dependentSnapshot() {
    const tables = ["artist_owners", "artist_profiles", "artist_verification_applications", "releases", "editions", "tokens", "provenance_proofs", "experiences", "media_assets", "transfers", "ownership_snapshots", "listings", "purchases", "primary_purchases", "audit_events", "contracts", "artist_contract_verifications"];
    const snapshot = {};
    for (const table of tables) {
      snapshot[table] = (await pool.query(`SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS h, count(*)::int AS n FROM ${table} t`)).rows[0];
    }
    return snapshot;
  }
  const artistRows = async () => (await pool.query("SELECT id, slug, status, updated_at FROM artists ORDER BY id")).rows;
  const statusOf = async (id) => (await pool.query("SELECT status FROM artists WHERE id=$1", [id])).rows[0]?.status;

  beforeAll(async () => {
    for (const file of ["01-precheck.sql", "02-archive.sql", "03-postcheck.sql", "04-reversal.sql"]) sql[file] = await readFile(join(OPS, file), "utf8");
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_alias_archive_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });

    const q = (text, values = []) => pool.query(text, values);
    // Canonical voidcaller (seeded by 019) keeps its contract-owner proof.
    await q("INSERT INTO artist_contract_verifications (id, artist_slug, wallet_address, contract_address, chain_id, signature, message) VALUES ('vc-claim','voidcaller',$1,'0xd1b4367dd9f235f9ee61878019d66e31511e98ee',43114,'0xsig','claim')", [OWNER]);
    const cert = (await q("INSERT INTO contracts (chain_id, chain_key, address, contract_type, name) VALUES (43113,'fuji',$1,'ERC1155','VoidRelease1155V2') RETURNING id", [CERTIFIED])).rows[0].id;
    const market = (await q("INSERT INTO contracts (chain_id, chain_key, address, contract_type, name) VALUES (43113,'fuji',$1,'MARKETPLACE','MusicMarketplace') RETURNING id", [MARKETPLACE])).rows[0].id;

    // Aliases, the certified artist, an unrelated artist and a decoy alias that is not a target.
    const artists = [...TARGETS, [VC7, "voidcaller-7"], ["artist-unrelated", "unrelated-artist"], ["artist-decoy-voidcaller-9", "voidcaller-9"]];
    for (const [id, slug] of artists) {
      await q("INSERT INTO artists (id, slug, display_name) VALUES ($1,$2,$3)", [id, slug, slug.startsWith("voidcaller") ? "Voidcaller" : "Unrelated"]);
      await q("INSERT INTO artist_owners (artist_id, owner_wallet, role) VALUES ($1,$2,'OWNER')", [id, E2E]);
    }
    await q("INSERT INTO artist_profiles (artist_id, bio) VALUES ($1,'certified fuji profile')", [VC7]);

    // voidcaller-2..5: one DRAFT release each, never on-chain. voidcaller-5 keeps a pending provenance proof.
    for (const [index, [id, slug]] of TARGETS.slice(0, 4).entries()) {
      await q("INSERT INTO releases (id, artist_id, slug, title, status) VALUES ($1,$2,$3,'Draft','DRAFT')", [`release-${slug}`, id, `draft-${slug}`]);
      await q("INSERT INTO editions (id, release_id, contract_id, title, status) VALUES ($1,$2,$3,'Draft','DRAFT')", [`edition-${slug}`, `release-${slug}`, cert]);
      await q("INSERT INTO tokens (edition_id, contract_id, token_id) VALUES ($1,$2,$3)", [`edition-${slug}`, cert, String(1000 + index)]);
    }
    await q(`INSERT INTO provenance_proofs (id, release_id, edition_id, creator_artist_id, creator_wallet, metadata_sha256, manifest_sha256, schema_version, proof_timestamp)
             VALUES ('proof-vc5','release-voidcaller-5','edition-voidcaller-5',$1,$2,$3,$4,1,now())`, [TARGET_IDS[3], E2E, "a".repeat(64), "b".repeat(64)]);

    // voidcaller-6: ARCHIVED Pinata certification release. voidcaller-8: ARCHIVED E2E release with chain history.
    for (const [id, slug, token] of [[TARGET_IDS[4], "voidcaller-6", "2000"], [TARGET_IDS[5], "voidcaller-8", E2E_TOKEN]]) {
      await q("INSERT INTO releases (id, artist_id, slug, title, status) VALUES ($1,$2,$3,'Test','ARCHIVED')", [`release-${slug}`, id, `test-${slug}`]);
      await q("INSERT INTO editions (id, release_id, contract_id, title, status, supply) VALUES ($1,$2,$3,'Test','ARCHIVED',1)", [`edition-${slug}`, `release-${slug}`, cert]);
      await q("INSERT INTO tokens (edition_id, contract_id, token_id, metadata_uri) VALUES ($1,$2,$3,'ipfs://test')", [`edition-${slug}`, cert, token]);
    }
    await q(`INSERT INTO transfers (chain_id, contract_address, token_id, from_wallet, to_wallet, amount, transaction_hash, block_number, block_hash, log_index, event_type, block_timestamp)
             VALUES (43113,$1,$2,'0x0000000000000000000000000000000000000000',$3,1,$4,10,$5,0,'MINT',now())`, [CERTIFIED, E2E_TOKEN, E2E, hex(8), hex(9)]);
    await q("INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES (43113,$1,$2,$3,1,10,$4,'FINALIZED')", [CERTIFIED, E2E_TOKEN, E2E, hex(9)]);

    // voidcaller-7: the certified Fuji release with its full production history.
    await q("INSERT INTO releases (id, artist_id, slug, title, status, published_at) VALUES ('release-8f6d5a9f-585d-4948-b05b-7098125d16cf',$1,'voidcaller','VOIDCALLER','PUBLISHED',now())", [VC7]);
    await q("INSERT INTO editions (id, release_id, contract_id, title, status, supply) VALUES ('edition-ecf27444-94b7-40d5-bace-5f061792f55e','release-8f6d5a9f-585d-4948-b05b-7098125d16cf',$1,'VOIDCALLER','PUBLISHED',25)", [cert]);
    await q("INSERT INTO tokens (edition_id, contract_id, token_id, metadata_uri) VALUES ('edition-ecf27444-94b7-40d5-bace-5f061792f55e',$1,$2,'ipfs://certified')", [cert, CERT_TOKEN]);
    await q(`INSERT INTO provenance_proofs (id, release_id, edition_id, creator_artist_id, creator_wallet, metadata_sha256, manifest_sha256, schema_version, proof_timestamp,
               chain_key, chain_id, transaction_hash, block_number, block_timestamp, anchor_contract, anchor_event, anchor_status, verification_status, verified_at)
             VALUES ('proof-vc7','release-8f6d5a9f-585d-4948-b05b-7098125d16cf','edition-ecf27444-94b7-40d5-bace-5f061792f55e',$1,$2,$3,$4,1,now(),
               'fuji',43113,$5,20,now(),$6,'EditionCreated','ANCHORED','VERIFIED',now())`, [VC7, E2E, "c".repeat(64), "d".repeat(64), hex(1), CERTIFIED]);
    await q("INSERT INTO media_assets (id, media_key, artist_id, storage_key, media_type) VALUES ('asset-vc7','asset-vc7',$1,'fuji/voidcaller-ep','AUDIO')", [VC7]);
    await q("INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, status) VALUES ('experience-vc7',$1,'release-8f6d5a9f-585d-4948-b05b-7098125d16cf','edition-ecf27444-94b7-40d5-bace-5f061792f55e','Full EP','AUDIO','PUBLISHED')", [VC7]);
    for (const [i, [from, to]] of [["0x0000000000000000000000000000000000000000", E2E], ["0x0000000000000000000000000000000000000000", OWNER], [E2E, OWNER]].entries()) {
      await q(`INSERT INTO transfers (chain_id, contract_address, token_id, from_wallet, to_wallet, amount, transaction_hash, block_number, block_hash, log_index, event_type, block_timestamp)
               VALUES (43113,$1,$2,$3,$4,1,$5,$6,$7,0,$8,now())`, [CERTIFIED, CERT_TOKEN, from, to, hex(i + 2), 30 + i, hex(i + 5), from.startsWith("0x0000") ? "MINT" : "TransferSingle"]);
    }
    await q("INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES (43113,$1,$2,$3,2,32,$4,'FINALIZED')", [CERTIFIED, CERT_TOKEN, OWNER, hex(7)]);
    const listing = (await q(`INSERT INTO listings (chain_id, marketplace_contract_id, listing_id, seller_wallet, token_contract_id, token_id, amount, remaining_amount, price_wei, status)
                              VALUES (43113,$1,1,$2,$3,$4,1,0,20000000000000000,'SOLD') RETURNING id`, [market, E2E, cert, CERT_TOKEN])).rows[0].id;
    await q(`INSERT INTO purchases (listing_id, chain_id, transaction_hash, settlement_log_index, buyer_wallet, seller_wallet, token_contract_address, token_id, quantity, sale_price_wei, block_number, block_hash, status)
             VALUES ($1,43113,$2,0,$3,$4,$5,$6,1,20000000000000000,32,$7,'CONFIRMED')`, [listing, hex(4), OWNER, E2E, CERTIFIED, CERT_TOKEN, hex(7)]);
    for (const n of [1, 2]) {
      await q(`INSERT INTO primary_purchases (chain_id, sale_contract_address, token_contract_address, transaction_hash, log_index, buyer_wallet, token_id, quantity, paid_wei, artist_cut_wei, platform_cut_wei, block_number, block_hash, status)
               VALUES (43113,$1,$2,$3,0,$4,$5,1,10000000000000000,9500000000000000,500000000000000,$6,$7,'CONFIRMED')`, [SALE, CERTIFIED, hex(n + 10), n === 1 ? E2E : OWNER, CERT_TOKEN, 40 + n, hex(n + 12)]);
    }
    for (let n = 0; n < 8; n += 1) {
      await q("INSERT INTO audit_events (event_type, actor_wallet, subject_type, subject_id) VALUES ('STUDIO_EVENT',$1,'release','release-8f6d5a9f-585d-4948-b05b-7098125d16cf')", [E2E]);
    }
  }, 120_000);

  afterAll(async () => {
    if (adminPool) await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("lives outside the deploy-time migration chain", async () => {
    // No deploy-time migration may reference any of the six target artists.
    for (const name of await listMigrations()) {
      const body = await readFile(join(migrationsDirectory, name), "utf8");
      for (const id of TARGET_IDS) expect(body.includes(id), `${name} references ${id}`).toBe(false);
    }
  });

  it("refuses partial, mismatched, or published states and leaves everything unchanged", async () => {
    const before = await artistRows();
    const deps = await dependentSnapshot();
    // Mixed state: one target already archived.
    await pool.query("UPDATE artists SET status='ARCHIVED' WHERE id=$1", [TARGET_IDS[0]]);
    await expect(run("02-archive.sql")).rejects.toThrow(/mixed state/);
    await pool.query("UPDATE artists SET status='ACTIVE', updated_at=$2 WHERE id=$1", [TARGET_IDS[0], before.find((row) => row.id === TARGET_IDS[0]).updated_at]);
    // id and slug must match exactly.
    await pool.query("UPDATE artists SET slug='voidcaller-3x' WHERE id=$1", [TARGET_IDS[1]]);
    await expect(run("02-archive.sql")).rejects.toThrow(/exact \(id, slug\) matches, found 5/);
    await pool.query("UPDATE artists SET slug='voidcaller-3', updated_at=$2 WHERE id=$1", [TARGET_IDS[1], before.find((row) => row.id === TARGET_IDS[1]).updated_at]);
    // A target owning live published content is refused.
    await pool.query("UPDATE releases SET status='PUBLISHED' WHERE id='release-voidcaller-4'");
    await expect(run("02-archive.sql")).rejects.toThrow(/PUBLISHED release/);
    await pool.query("UPDATE releases SET status='DRAFT' WHERE id='release-voidcaller-4'");
    // Protected rows must be ACTIVE.
    await pool.query("UPDATE artists SET status='ARCHIVED' WHERE id=$1", [VC7]);
    await expect(run("02-archive.sql")).rejects.toThrow(/voidcaller-7 is not ACTIVE/);
    await pool.query("UPDATE artists SET status='ACTIVE', updated_at=$2 WHERE id=$1", [VC7, before.find((row) => row.id === VC7).updated_at]);
    expect(await artistRows()).toEqual(before);
    expect((await dependentSnapshot()).releases.n).toBe(deps.releases.n);
  });

  it("archives exactly the six targets, preserves all dependent data, is idempotent and reversible", async () => {
    // PRE-CHECK
    const pre = (await run("01-precheck.sql")).rows;
    expect(pre).toHaveLength(8);
    expect(pre.every((row) => row.ready_to_archive)).toBe(true);
    expect(pre.filter((row) => row.role === "TARGET").every((row) => row.current_status === "ACTIVE" && row.exact_id_slug_match && !row.target_has_published_release)).toBe(true);
    expect(pre.find((row) => row.slug === "voidcaller-7")).toMatchObject({ current_status: "ACTIVE", releases_published: "1", certified_token_ok: true, listing_1: `1:SOLD:${E2E}:0` });
    const preFingerprints = Object.fromEntries(pre.map((row) => [row.artist_id, row.dependency_fingerprint]));
    const vc7 = pre.find((row) => row.slug === "voidcaller-7");
    // 1 release + 1 edition + 1 token + provenance + experience + media + 3 transfers + 1 holder + listing + purchase + 2 primary + 8 audit + owner + profile
    expect(Number(vc7.dependency_rows)).toBe(24);
    const artistsBefore = await artistRows();
    const depsBefore = await dependentSnapshot();

    // CLEANUP
    const first = await run("02-archive.sql");
    expect(first.notices.join(" ")).toMatch(/6 row\(s\) changed/);
    const artistsAfter = await artistRows();
    const changed = artistsAfter.filter((row) => {
      const prior = artistsBefore.find((item) => item.id === row.id);
      return prior.status !== row.status || prior.updated_at.getTime() !== row.updated_at.getTime();
    });
    expect(changed.map((row) => row.id).sort()).toEqual([...TARGET_IDS].sort());
    expect(changed.every((row) => row.status === "ARCHIVED")).toBe(true);
    for (const id of ["voidcaller", VC7, "artist-unrelated", "artist-decoy-voidcaller-9"]) expect(await statusOf(id)).toBe("ACTIVE");
    expect(await dependentSnapshot()).toEqual(depsBefore);

    // POST-CHECK
    const post = (await run("03-postcheck.sql")).rows;
    expect(post.every((row) => row.all_checks_pass && row.status_ok)).toBe(true);
    expect(post[0].targets_archived).toBe("6");
    for (const row of post) expect(row.dependency_fingerprint).toBe(preFingerprints[row.artist_id]);
    expect(post.find((row) => row.slug === "voidcaller-7").listing_1).toBe(`1:SOLD:${E2E}:0`);

    // IDEMPOTENCY: second run changes nothing and does not fail.
    const second = await run("02-archive.sql");
    expect(second.notices.join(" ")).toMatch(/0 row\(s\) changed/);
    expect(await artistRows()).toEqual(artistsAfter);
    expect(await dependentSnapshot()).toEqual(depsBefore);

    // REVERSAL: only the six return to ACTIVE; protected rows are untouched; re-run is a no-op.
    const reversed = await run("04-reversal.sql");
    expect(reversed.notices.join(" ")).toMatch(/6 row\(s\) restored/);
    const artistsReversed = await artistRows();
    for (const row of artistsReversed) {
      const prior = artistsBefore.find((item) => item.id === row.id);
      expect(row.status).toBe(prior.status);
      if (!TARGET_IDS.includes(row.id)) expect(row.updated_at.getTime()).toBe(prior.updated_at.getTime());
    }
    expect((await run("04-reversal.sql")).notices.join(" ")).toMatch(/0 row\(s\) restored/);
    expect(await dependentSnapshot()).toEqual(depsBefore);
    const again = (await run("01-precheck.sql")).rows;
    for (const row of again) expect(row.dependency_fingerprint).toBe(preFingerprints[row.artist_id]);
  });
});
