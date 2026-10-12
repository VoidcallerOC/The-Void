#!/usr/bin/env node
// Prepares the Fuji Rabby test plan, without any key: reads the deployer's live Fuji nonce, builds the
// RabbySigningProbe creation from the compiled artifact (forge build first), binds it to the source
// commit, and writes deploy/fuji/approved-plans/rabby-probe-fuji.json for review. Merging the PR that
// adds the file approves the test transaction; the owner then signs it in Rabby on /fuji-rabby-test.
// Usage: node scripts/fuji-rabby-probe-plan.mjs --commit <40-hex sha> [--rpc <fuji rpc>] [--print]
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider } from "ethers";
import { assertNoPrivateKeyInEnv } from "./mainnet-signing-requests.mjs";
import { NETWORK_PROFILES } from "./network-profiles.mjs";
import { PROBE_ARTIFACT_PATH, PROBE_KIND, buildProbePlan } from "./fuji-rabby-probe.mjs";
import { bindPlan } from "./plan-binding-core.mjs";
import { validateApprovedPlan } from "./approved-plan.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FUJI = NETWORK_PROFILES.fuji;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  assertNoPrivateKeyInEnv(process.env, "Fuji test planning");
  const commit = arg("--commit") || execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const provider = new JsonRpcProvider(arg("--rpc") || FUJI.rpc, FUJI.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const artifact = JSON.parse(await readFile(resolve(ROOT, PROBE_ARTIFACT_PATH), "utf8"));
  const plan = JSON.parse(JSON.stringify(await buildProbePlan(provider, artifact)));
  const entry = validateApprovedPlan({ kind: PROBE_KIND, plan, binding: bindPlan(PROBE_KIND, plan, commit) }, "fuji");
  if (process.argv.includes("--print")) { console.log(JSON.stringify(entry, null, 2)); return; }
  const out = resolve(ROOT, FUJI.plansDir, `${PROBE_KIND}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`Wrote ${out}\nbinding ${entry.binding.digest}\nnonce ${plan.deployer.nonce}, creates ${plan.probe.predictedAddress}, max cost ${plan.cost.maxCostWei} wei (Fuji test AVAX)`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
