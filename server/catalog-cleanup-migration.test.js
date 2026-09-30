import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./migrations/024_archive_test_catalog_content.sql", import.meta.url);
const releaseIds = [
  "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7",
  "release-7f12ecfb-99eb-4b05-9b07-f862480829c5",
  "release-f049bc8c-2ff1-4ebf-8830-ebd92784864a",
  "release-f2ce5be7-969a-4e9f-87fb-be839b9df380",
  "release-cf0bcf5f-3f6a-466f-9661-0c56f58fe3e3",
  "release-176a05cf-fe88-4c33-a7db-c9ef4b1e90de",
];
const artistProfileIds = [
  "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e",
  "artist-fa19e2f0-bc20-4b7c-8698-c5f1db59fd6a",
  "artist-da7b5bfb-7cc3-4c35-be3a-7543e4e54138",
  "artist-454ea216-9ce5-4c9d-b904-08eb7bb18bf3",
];

describe("test catalog cleanup migration", () => {
  it("archives only the exact confirmed test/certification releases and their dependent public content", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toMatch(/UPDATE\s+experiences\s+AS\s+x[\s\S]*?SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(sql).toMatch(/UPDATE\s+editions\s+AS\s+e[\s\S]*?SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(sql).toMatch(/UPDATE\s+releases\s+AS\s+r[\s\S]*?SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(sql).toMatch(/UPDATE\s+artists\s+AS\s+a[\s\S]*?SET\s+status\s*=\s*'ARCHIVED'/i);
    for (const id of releaseIds) expect(sql).toContain(id);
    for (const id of artistProfileIds) expect(sql).toContain(id);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/UPDATE\s+(?:artist_owners|artist_profiles|users|user_accounts|auth_users|tokens|listings|listing_status_history|transactions|purchases)\b/i);
  });
});
