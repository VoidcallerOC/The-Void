import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vitest resolves JSON imports without `with { type: "json" }`; plain Node does
// not, and a missing attribute crashed a production API deploy. Load each
// server entry in a real Node process so CI catches it.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["./server/index.js", "./server/indexer-worker.js", "./server/migrate.js"];

describe("server entrypoints load in plain Node", () => {
  for (const entry of ENTRIES) {
    it(`imports ${entry}`, () => {
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)}); console.log("ok");`], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(output.trim().split("\n").at(-1)).toBe("ok");
    });
  }
});
