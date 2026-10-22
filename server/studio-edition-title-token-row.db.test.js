import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { createPersistenceRepository } from "./repositories.js";
import { ArtistStudioService } from "./studio-service.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: re-saving an unsubmitted draft edition under a new title must not leave the edition with a
// second token row. The token ID derives from the edition title, so a rename produces a new token ID. Skipped
// without TEST_DATABASE_URL. Nothing here reads or writes production.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const CHAIN = 43114;
const OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const RELEASE = "release-title-token-row";
const OTHER_RELEASE = "release-other-contract";
const FACTORY = "0xe744d58fa8138042f5f00a28d39f89081539c19b";
const CONTRACT = "0x8192cc13caec165afd802af691f952573bb3d817";
const SALE = "0x1091af3886a43896d5804f785782db911c308d81";
const ANCHOR = "0xd07ae2b67528958303e1f1130d97b2e433aff24e";
const OTHER_CONTRACT = "0x09969f81308f28516736492ddded643abac5670d";
const OTHER_SALE = "0x3b4cb323693894929c4b7a9f1747e7390219023e";
const OTHER_ANCHOR = "0x775980c1b75e5553f71a1a17db72d6b61c85dfad";
const IMPLEMENTATION = "0x36c5d31e9a8e9b4dc9f8cb4b7202c70b3e30734d";
const request = { requestId: "request-1", headers: {} };

describe.skipIf(!testDatabaseUrl)("Edition title changes and token rows (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let studio;
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const tokensOf = (editionId) => q("SELECT t.token_id::text AS token_id, t.metadata_uri, c.address FROM tokens t JOIN contracts c ON c.id=t.contract_id WHERE t.edition_id=$1 ORDER BY t.created_at", [editionId]);

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_title_token_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('voidcaller','voidcaller','Voidcaller') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet) VALUES ('voidcaller',$1) ON CONFLICT DO NOTHING", [OWNER]);
    const contract = async (address, type = "ERC1155") => (await q("INSERT INTO contracts (chain_id, chain_key, address, contract_type) VALUES ($1,'avalanche',$2,$3) RETURNING id", [CHAIN, address, type]))[0].id;
    const factory = await contract(FACTORY, "OTHER");
    for (const [release, release_contract, sale, anchor, key] of [[RELEASE, CONTRACT, SALE, ANCHOR, "63"], [OTHER_RELEASE, OTHER_CONTRACT, OTHER_SALE, OTHER_ANCHOR, "b0"]]) {
      await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata) VALUES ($1,'voidcaller',$1,'Forgive and Forget','DRAFT',$2)", [release, JSON.stringify({ chainId: CHAIN, releaseType: "SINGLE", publicationArchitecture: "release-per-contract" })]);
      await pool.query(
        "INSERT INTO release_contracts (release_id, chain_id, release_contract_id, factory_contract_id, primary_sale_contract_id, provenance_anchor_contract_id, release_key, artist_wallet, implementation_address, implementation_version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2,'DEPLOYED')",
        [release, CHAIN, await contract(release_contract), factory, await contract(sale), await contract(anchor), `0x${key.repeat(32)}`, OWNER, IMPLEMENTATION]);
    }
    studio = new ArtistStudioService({ db: pool, repository: createPersistenceRepository(pool), authenticator: async () => ({ wallet: OWNER }), logger: { info() {}, error() {} } });
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  const create = (input, releaseId = RELEASE) => studio.createEdition({ request, releaseId, input });
  let editionId;
  let firstToken;

  it("creates the draft edition with one token row derived from its title", async () => {
    const edition = await create({ trackTitle: "Forgive and Forget", quantity: "25" });
    editionId = edition.id;
    const tokens = await tokensOf(editionId);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].metadata_uri).toBeNull();
    firstToken = tokens[0].token_id;
  });

  it("re-saving the unsubmitted draft under a new title leaves exactly one token row, for the new title", async () => {
    const edition = await create({ id: editionId, trackTitle: "Forgive & Forget", quantity: "0" });
    expect(edition.id).toBe(editionId);
    const tokens = await tokensOf(editionId);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_id).not.toBe(firstToken); // the title is part of the token ID derivation
    expect(tokens[0].address).toBe(CONTRACT);
    expect((await q("SELECT title, supply::text AS supply FROM editions WHERE id=$1", [editionId]))[0]).toEqual({ title: "Forgive & Forget", supply: "0" }); // open edition
  });

  it("re-saving with the same title is idempotent", async () => {
    const before = await tokensOf(editionId);
    await create({ id: editionId, trackTitle: "Forgive & Forget", quantity: "0" });
    expect(await tokensOf(editionId)).toEqual(before);
  });

  it("never removes a token row whose metadata was already submitted for publication", async () => {
    const edition = await create({ trackTitle: "Submitted Track", quantity: "0" });
    await pool.query("UPDATE tokens SET metadata_uri='ipfs://QmSubmitted' WHERE edition_id=$1", [edition.id]);
    const submitted = await tokensOf(edition.id);
    await create({ id: edition.id, trackTitle: "Submitted Track Renamed", quantity: "0" });
    const rows = await tokensOf(edition.id);
    expect(rows.map((row) => row.token_id)).toEqual(expect.arrayContaining([submitted[0].token_id]));
    expect(rows.find((row) => row.token_id === submitted[0].token_id).metadata_uri).toBe("ipfs://QmSubmitted");
  });

  it("does not touch another edition's tokens, on this or another release contract", async () => {
    const other = await create({ trackTitle: "Forgive & Forget" }, OTHER_RELEASE); // same slug, token ID on a different contract
    const before = await tokensOf(other.id);
    expect(before).toHaveLength(1);
    await create({ id: editionId, trackTitle: "Forgive & Forget", quantity: "0" });
    expect(await tokensOf(other.id)).toEqual(before);
    expect(before[0].address).toBe(OTHER_CONTRACT);
    expect((await tokensOf(editionId))[0].token_id).toBe(before[0].token_id); // same token ID, different contract
  });
});
