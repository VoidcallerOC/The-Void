import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { listMigrations, migrationBody, migrationsDirectory } from "./migrate.js";

// The forgive-forget-6 retirement, reviewed while staged in deploy/mainnet/pending-migrations/ and activated in
// server/migrations by its own PR (runbook step 5): the runner applies it on the next API start.
const name = "049_retire_forgive_forget_6_replaced_by_sequential.sql";
const migrationPath = new URL(`./migrations/${name}`, import.meta.url);
const release = "release-e3743294-2ea3-46ae-b006-f0402606af65";
const edition = "edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d";
const experiences = [
  "experience-edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d-experience-audio",
  "experience-edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d-full-track",
];
// Earlier Forgive & Forget releases, the Genesis release and their editions: never a predicate here.
const others = [
  "release-83611741-c9ee-4487-a438-b6fa844762e6",
  "release-273f5476-0cdb-45d3-83d3-5908eb42bc6c",
  "release-cd9c689c-8b90-41ee-b4e4-0124a63d6819",
  "release-84f72628-2c74-4a53-96db-fe495f0f9220",
  "release-88dbe3b8-dce2-4d98-857c-10b7fa8f64ca",
  "release-7bc53df7-abc7-4b10-8328-f7aec4c3b601",
  "voidcaller-legacy-genesis",
];

describe("forgive-forget-6 retirement migration (static)", () => {
  it("is active as the next migration after 048, exactly once, and no longer staged", async () => {
    const migrations = await listMigrations();
    expect(migrations.filter((file) => file.includes("forgive_forget_6"))).toEqual([name]);
    expect(migrations.indexOf(name)).toBe(migrations.indexOf("048_retire_forgive_forget_5_no_clones.sql") + 1);
    expect(migrations.filter((file) => file.startsWith("049_"))).toEqual([name]);
    expect(await readdir(new URL("../deploy/mainnet/pending-migrations/", import.meta.url))).not.toContain(name);
    expect(await readdir(migrationsDirectory)).toContain(name);
  });

  it("is runner-compatible (one outer transaction) and targets only forgive-forget-6, by ID, lifecycle status only", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(() => migrationBody(sql, name)).not.toThrow();
    expect(sql.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
    const code = sql.replace(/--.*$/gm, "");
    expect(code).toMatch(/UPDATE\s+experiences\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(code).toMatch(/UPDATE\s+editions\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(code).toMatch(/UPDATE\s+releases\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    const updates = [...code.matchAll(/UPDATE\s+\w+[\s\S]*?(?:RETURNING|;)/gi)].map((match) => match[0]);
    expect(updates.map((update) => update.match(/UPDATE\s+(\w+)/i)[1])).toEqual(["experiences", "editions", "releases"]);
    for (const update of updates) {
      // Every update skips rows already ARCHIVED (re-running is a no-op) and is pinned to this release by ID.
      expect(update).toMatch(/status\s*<>\s*'ARCHIVED'/i);
      expect(update).toContain(release);
      const where = update.slice(update.search(/\bWHERE\b/i));
      // No title, slug, artist, asset or token predicate can widen the match.
      expect(where).not.toMatch(/\b(?:title|slug|artist_id|media_config|token_id|asset|contract_id)\b/i);
      for (const id of others) expect(update).not.toContain(id);
    }
    expect(updates[0]).toContain(edition);
    // The marker is merged into the existing jsonb, so releaseKey (which the indexer matches) is kept.
    expect(updates[1]).toMatch(/application_metadata\s*=\s*coalesce\(application_metadata,\s*'\{\}'::jsonb\)\s*\|\|\s*jsonb_build_object\('abandoned'/i);
    expect(updates[2]).toMatch(/release_metadata\s*=\s*coalesce\(release_metadata,\s*'\{\}'::jsonb\)\s*\|\|\s*jsonb_build_object\('abandoned'/i);
    expect(code.match(/REPLACED_BY_SEQUENTIAL_RELEASE/g).length).toBeGreaterThanOrEqual(3);
    for (const id of experiences) expect(code).toContain(id);
    // The audit row is written only when the release itself changed, and names this file.
    expect(code).toMatch(/WITH\s+archived\s+AS\s*\(\s*UPDATE\s+releases[\s\S]*RETURNING\s+id\s*\)\s*INSERT\s+INTO\s+audit_events[\s\S]*FROM\s+archived\s*;/i);
    expect(code.match(new RegExp(`'migration',\\s*'${name.replace(/\./g, "\\.")}'`, "g"))).toHaveLength(3);
  });

  it("never deletes, alters or updates a record outside the three lifecycle tables", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\b|\bALTER\b|\bCREATE\b|\bGRANT\b/i);
    expect(code).not.toMatch(/UPDATE\s+(?:media_assets|tokens|contracts|release_contracts|factory_releases|release_provisioning_requests|provenance_proofs|primary_purchases|purchases|primary_sales|sales|ownership_snapshots|transfers|listings|transactions|artist_owners|artists|audit_events)\b/i);
    expect(code.match(/\bINSERT\s+INTO\s+(\w+)/gi)).toEqual(["INSERT INTO audit_events"]);
    expect(sql).toMatch(/db:migrate/);
    expect(sql).toMatch(/Reversal/);
  });
});
