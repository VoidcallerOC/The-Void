import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath , pathToFileURL} from "node:url";
import { APPROVED_KINDS, validateApprovedPlan } from "./approved-plan.mjs";

// Reads a committed approved plan (deploy/mainnet/approved-plans/<kind>.json), validates it, and
// writes its plan and binding as separate files for the key-less verify command. No keys, no network.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const approvedPlanPath = (kind) => resolve(ROOT, "deploy/mainnet/approved-plans", `${kind}.json`);

export async function readApprovedPlan(kind) {
  if (!APPROVED_KINDS.includes(kind)) throw new Error(`--kind must be one of: ${APPROVED_KINDS.join(", ")}.`);
  return validateApprovedPlan(JSON.parse(await readFile(approvedPlanPath(kind), "utf8")));
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const value = (name) => { const at = rest.indexOf(`--${name}`); if (at < 0 || !rest[at + 1]) throw new Error(`--${name} is required.`); return rest[at + 1]; };
  if (command !== "split") throw new Error('Use "split --kind <kind> --out <dir>".');
  const entry = await readApprovedPlan(value("kind"));
  const out = resolve(value("out"));
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "plan.json"), `${JSON.stringify(entry.plan, null, 2)}\n`);
  await writeFile(resolve(out, "plan-binding.json"), `${JSON.stringify(entry.binding, null, 2)}\n`);
  console.log(JSON.stringify({ step: "APPROVED_PLAN", kind: entry.kind, digest: entry.binding.digest }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Approved plan refused: ${error.message}`);
    process.exitCode = 1;
  });
}
