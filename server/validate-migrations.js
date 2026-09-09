import { readFile } from "node:fs/promises";
import process from "node:process";
import { listMigrations, migrationBody } from "./migrate.js";

export async function validateMigrations() {
  const migrations = await listMigrations();
  if (!migrations.length) throw new Error("No migrations were discovered.");
  const expected = migrations.map((_, index) => String(index + 1).padStart(3, "0"));
  for (const [index, name] of migrations.entries()) {
    if (!name.startsWith(`${expected[index]}_`)) throw new Error(`Migration sequence is not contiguous at ${name}.`);
    const source = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
    migrationBody(source, name);
  }
  return { ok: true, migrations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateMigrations()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
