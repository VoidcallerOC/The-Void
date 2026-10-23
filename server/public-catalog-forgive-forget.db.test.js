import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiService } from "./api-service.js";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: after the Forgive & Forget resets, no retired or draft Forgive & Forget release, edition or
// experience is returned by the public catalog reads, while an unrelated published release still is. Fixtures mirror
// the production lifecycle states (five ARCHIVED releases plus one abandoned DRAFT). Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const RETIRED = [
  ["release-83611741-c9ee-4487-a438-b6fa844762e6", "forgive-forget", "ARCHIVED"],
  ["release-273f5476-0cdb-45d3-83d3-5908eb42bc6c", "forgive-forget-2", "ARCHIVED"],
  ["release-cd9c689c-8b90-41ee-b4e4-0124a63d6819", "forgive-and-forget", "ARCHIVED"],
  ["release-84f72628-2c74-4a53-96db-fe495f0f9220", "forgive-forget-3", "ARCHIVED"],
  ["release-88dbe3b8-dce2-4d98-857c-10b7fa8f64ca", "forgive-forget-4", "ARCHIVED"],
  ["release-7bc53df7-abc7-4b10-8328-f7aec4c3b601", "forgive-forget-5", "DRAFT"],
];
const UNRELATED = "release-unrelated-published";

describe.skipIf(!testDatabaseUrl)("Public catalog after the Forgive & Forget resets (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let service;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_public_ff_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('voidcaller','voidcaller','Voidcaller'), ('other-artist','other-artist','Other Artist') ON CONFLICT DO NOTHING");
    for (const [id, slug, status] of RETIRED) {
      await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata) VALUES ($1,'voidcaller',$2,'Forgive & Forget',$3,'{}')", [id, slug, status]);
      const editionId = `edition-of-${id}`;
      await pool.query("INSERT INTO editions (id, release_id, title, status, supply) VALUES ($1,$2,'Forgive & Forget',$3,0)", [editionId, id, status]);
      await pool.query("INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, status) VALUES ($1,'voidcaller',$2,$3,'Forgive & Forget','AUDIO','[]','{}',$4)", [`experience-of-${id}`, id, editionId, status]);
    }
    await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata, published_at) VALUES ($1,'other-artist','unrelated','Unrelated Single','PUBLISHED','{}', now())", [UNRELATED]);
    await pool.query("INSERT INTO editions (id, release_id, title, status, supply) VALUES ('edition-unrelated',$1,'Unrelated Single','PUBLISHED',10)", [UNRELATED]);
    await pool.query("INSERT INTO experiences (id, artist_id, release_id, edition_id, title, experience_type, requirements, media_config, status) VALUES ('experience-unrelated','other-artist',$1,'edition-unrelated','Unrelated Single','AUDIO','[]','{}','PUBLISHED')", [UNRELATED]);
    service = new ApiService({ db: pool, repository: {}, logger: { info() {}, error() {} } });
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  const mentionsForgive = (rows) => JSON.stringify(rows).toLowerCase().includes("forgive");

  it("returns no Forgive & Forget release, edition or experience from the public lists", async () => {
    const releases = await service.listReleases({ limit: 100, offset: 0 });
    const editions = await service.listEditions({ limit: 100, offset: 0 });
    const experiences = await service.listExperiences({ limit: 100, offset: 0 });
    for (const rows of [releases, editions, experiences]) expect(mentionsForgive(rows)).toBe(false);
    expect(releases.map((row) => row.id)).toContain(UNRELATED);
    expect(editions.map((row) => row.id)).toContain("edition-unrelated");
    expect(experiences.map((row) => row.id)).toContain("experience-unrelated");
  });

  it("does not serve any retired or draft release by id or slug", async () => {
    for (const [id, slug] of RETIRED) {
      await expect(service.getRelease({ idOrSlug: id }), id).rejects.toMatchObject({ status: 404, code: "RELEASE_NOT_FOUND" });
      await expect(service.getRelease({ idOrSlug: slug }), slug).rejects.toMatchObject({ status: 404, code: "RELEASE_NOT_FOUND" });
    }
  });

  it("does not return the retired artist's content when listing by that artist", async () => {
    expect(mentionsForgive(await service.listReleases({ artistId: "voidcaller", limit: 100, offset: 0 }))).toBe(false);
    expect(mentionsForgive(await service.listEditions({ releaseId: RETIRED[0][0], limit: 100, offset: 0 }))).toBe(false);
    expect(mentionsForgive(await service.listExperiences({ releaseId: RETIRED[3][0], limit: 100, offset: 0 }))).toBe(false);
  });
});
