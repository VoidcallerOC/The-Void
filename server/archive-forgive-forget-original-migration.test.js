import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { migrationBody } from "./migrate.js";

const name = "043_archive_forgive_forget_original.sql";
const original = "release-83611741-c9ee-4487-a438-b6fa844762e6";
const replacement = "release-273f5476-0cdb-45d3-83d3-5908eb42bc6c";
const editions = ["edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7", "edition-6e35101c-4987-4695-ac96-d83061ef2673"];

describe("original Forgive & Forget retirement migration (static)", () => {
  it("is runner-compatible, targets only the original release's exact rows, and changes lifecycle status only", async () => {
    const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
    expect(() => migrationBody(sql, name)).not.toThrow();
    expect(sql).toContain(original);
    for (const id of editions) expect(sql).toContain(id);
    expect(sql).toMatch(/UPDATE\s+experiences\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(sql).toMatch(/UPDATE\s+editions\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    expect(sql).toMatch(/UPDATE\s+releases\s+SET\s+status\s*=\s*'ARCHIVED'/i);
    // Only rows that are not already archived change, so a re-run is a no-op.
    expect(sql.match(/status\s*<>\s*'ARCHIVED'/g)).toHaveLength(3);
    // The replacement is named only as audit context, never as an update target.
    const code = sql.replace(/--.*$/gm, "");
    const updates = [...code.matchAll(/UPDATE\s+\w+[\s\S]*?(?:RETURNING|;)/gi)].map((match) => match[0]);
    expect(updates).toHaveLength(3);
    for (const update of updates) expect(update).not.toContain(replacement);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\b/i);
    expect(sql).not.toMatch(/UPDATE\s+(?:media_assets|tokens|contracts|primary_purchases|purchases|ownership_snapshots|transactions|listings|release_contracts|release_provisioning_requests|factory_releases|artist_owners)\b/i);
  });
});
