import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { migrationBody } from "./migrate.js";

const name = "044_retire_ep_replacement_forgive_forget.sql";
const retired = "release-273f5476-0cdb-45d3-83d3-5908eb42bc6c";
const single = "release-cd9c689c-8b90-41ee-b4e4-0124a63d6819";
const original = "release-83611741-c9ee-4487-a438-b6fa844762e6";
const originalEditions = ["edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7", "edition-6e35101c-4987-4695-ac96-d83061ef2673"];
const editions = ["edition-81122aa5-c0b8-446b-8dec-09b061ebca60", "edition-485c1e90-1ef4-4f42-98a4-0e5eab8b94e9"];
const experiences = [
  "experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-experience-audio",
  "experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-full-track",
];

describe("EP replacement retirement migration (static)", () => {
  it("is runner-compatible and targets only the EP replacement's exact rows, by ID, lifecycle status only", async () => {
    const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
    expect(() => migrationBody(sql, name)).not.toThrow();
    const code = sql.replace(/--.*$/gm, "");
    expect(code).toContain(retired);
    for (const id of [...editions, ...experiences]) expect(code).toContain(id);
    expect(code).toMatch(/UPDATE\s+experiences\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(code).toMatch(/UPDATE\s+editions\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(code).toMatch(/UPDATE\s+releases\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    // Only DRAFT or REVIEW rows change: a PUBLISHED (confirmed) or already ARCHIVED row is skipped.
    expect(code.match(/status\s+IN\s*\('DRAFT',\s*'REVIEW'\)/g)).toHaveLength(3);
    // Exactly three updates, each pinned to the replacement by ID.
    const updates = [...code.matchAll(/UPDATE\s+\w+[\s\S]*?(?:RETURNING|;)/gi)].map((match) => match[0]);
    expect(updates).toHaveLength(3);
    for (const update of updates) {
      expect(update).toContain(retired);
      expect(update).not.toContain(single);
      expect(update).not.toContain(original);
      for (const id of originalEditions) expect(update).not.toContain(id);
      // No title, slug, artist, asset or token predicate can widen the match.
      expect(update).not.toMatch(/\b(?:title|slug|artist_id|media_config|token_id|asset)\b/i);
    }
    // The Single is audit context only.
    expect(code.match(new RegExp(single, "g"))).toHaveLength(1);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\b|\bALTER\b/i);
    expect(sql).not.toMatch(/UPDATE\s+(?:media_assets|tokens|contracts|primary_purchases|purchases|ownership_snapshots|transactions|listings|release_contracts|release_provisioning_requests|factory_releases|artist_owners|artists)\b/i);
    expect(sql).toMatch(/db:migrate/);
  });
});
