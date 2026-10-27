#!/usr/bin/env node
import { pathToFileURL } from "node:url";
// Prepares the Fuji Genesis claim deployment plan, without any key. It reads the artist's release,
// edition and sale from Fuji, simulates the claim constructor, and builds the one unsigned creation
// transaction for the Rabby deployer, with the artist as claim admin and the PLACEHOLDER voucher
// signer (no key exists for it, so no voucher can be valid until the artist rotates the signer).
// Writes deploy/fuji/approved-plans/genesis-claim-fuji.json for review. Merging the PR that adds it
// approves the transaction; the owner then signs it in Rabby on /fuji-rabby-test. Nothing is sent.
// Usage: node scripts/fuji-genesis-claim-plan.mjs --release 0x… --sale 0x… --token <id> --claim-start <unix>
//        [--commit <sha>] [--rpc <fuji rpc>] [--genesis-rpc <c-chain rpc>] [--print]
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider } from "ethers";
import { claimSigningPlan, loadClaimArtifact, preflightClaimDeployment, buildPlan, validateClaimDeploymentEnv } from "./deploy-genesis-claim.mjs";
import { assertNoPrivateKeyInEnv } from "./mainnet-signing-requests.mjs";
import { NETWORK_PROFILES } from "./network-profiles.mjs";
import { FUJI_CLAIM_ARTIST, FUJI_CLAIM_KIND, FUJI_CLAIM_WINDOW_SECONDS, FUJI_GENESIS_VOUCHER_SIGNER, FUJI_PUBLIC_PRICE_WEI, FUJI_PUBLIC_WINDOW_SECONDS } from "./fuji-genesis-claim.mjs";
import { bindPlan } from "./plan-binding-core.mjs";
import { validateApprovedPlan } from "./approved-plan.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FUJI = NETWORK_PROFILES.fuji;
const C_CHAIN_RPC = NETWORK_PROFILES.mainnet.rpc;

/** The reviewed Fuji claim plan for a release, edition and sale the artist already created. */
export async function buildFujiClaimEntry({ release, sale, token, claimStart, commit, rpc = FUJI.rpc, genesisRpc = C_CHAIN_RPC, provider, genesisProvider, artifact }) {
  const config = validateClaimDeploymentEnv({
    DEPLOY_NETWORK: "fuji", AVALANCHE_FUJI_RPC_URL: rpc, GENESIS_RPC_URL: genesisRpc,
    EXPECTED_DEPLOYER_ADDRESS: FUJI.deployer,
    GENESIS_CLAIM_RELEASE_CONTRACT: release, GENESIS_CLAIM_PRIMARY_SALE: sale, GENESIS_CLAIM_TOKEN_ID: String(token),
    GENESIS_CLAIM_START: String(claimStart), GENESIS_CLAIM_WINDOW_SECONDS: String(FUJI_CLAIM_WINDOW_SECONDS), GENESIS_PUBLIC_WINDOW_SECONDS: String(FUJI_PUBLIC_WINDOW_SECONDS),
    GENESIS_PUBLIC_PRICE_WEI: FUJI_PUBLIC_PRICE_WEI, GENESIS_CLAIM_ALLOCATION: "0", GENESIS_PUBLIC_MINT_ALLOCATION: "0", GENESIS_EXPECT_OPEN_EDITION: "yes",
    GENESIS_CLAIM_ADMIN: FUJI_CLAIM_ARTIST, GENESIS_CLAIM_SIGNER_ADDRESS: FUJI_GENESIS_VOUCHER_SIGNER,
  });
  provider ??= new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true, cacheTimeout: -1 });
  genesisProvider ??= new JsonRpcProvider(config.genesisRpcUrl, 43114, { staticNetwork: true, cacheTimeout: -1 });
  artifact ??= await loadClaimArtifact();
  const facts = await preflightClaimDeployment(config, { provider, genesisProvider, artifact });
  if (facts.pendingNonce !== facts.deployerNonce) throw new Error(`The deployer has pending Fuji transactions (latest ${facts.deployerNonce}, pending ${facts.pendingNonce}).`);
  const plan = JSON.parse(JSON.stringify(await claimSigningPlan(config, facts, buildPlan(config, facts), { provider, artifact })));
  const [request] = plan.signingRequests;
  const feeData = await provider.getFeeData();
  const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const entryPlan = {
    mode: "DRY_RUN",
    ...plan,
    purpose: "TEST ONLY (Fuji): deploys the Genesis claim with the artist as admin and the dedicated Genesis voucher signer. Claims also need the artist ISSUER_ROLE grant, the server signing secret and owner-authorized activation.",
    observedAt: { time: new Date().toISOString(), block: facts.fujiBlock },
    cost: { gasLimit: request.gasLimit, maxFeePerGasWei: price.toString(), maxCostWei: (BigInt(request.gasLimit) * price).toString() },
  };
  return validateApprovedPlan({ kind: FUJI_CLAIM_KIND, plan: entryPlan, binding: bindPlan(FUJI_CLAIM_KIND, entryPlan, commit) }, "fuji");
}

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  assertNoPrivateKeyInEnv(process.env, "Fuji claim planning");
  const commit = arg("--commit") || execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const entry = await buildFujiClaimEntry({ release: arg("--release"), sale: arg("--sale"), token: arg("--token"), claimStart: arg("--claim-start"), commit, rpc: arg("--rpc"), genesisRpc: arg("--genesis-rpc") });
  if (process.argv.includes("--print")) { console.log(JSON.stringify(entry, null, 2)); return; }
  const out = resolve(ROOT, FUJI.plansDir, `${FUJI_CLAIM_KIND}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(entry, null, 2)}\n`);
  const { plan, binding } = entry;
  console.log(`Wrote ${out}\nbinding ${binding.digest}\nnonce ${plan.deployerNonce}, creates ${plan.predictedClaimAddress}, max cost ${plan.cost.maxCostWei} wei (Fuji test AVAX)\nclaim opens ${plan.schedule.claimStart}; admin ${plan.roles.admin}; voucher signer ${plan.roles.signer}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exit(1); });
