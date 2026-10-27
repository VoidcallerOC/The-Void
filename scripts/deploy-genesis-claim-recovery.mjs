#!/usr/bin/env node
// Separate recovery deployment path. Does not touch the original claim deployment script.
// Default is dry-run only. Never broadcasts without explicit CONFIRM_MAINNET_DEPLOY=yes.
import { readFile } from "node:fs/promises";
import process from "node:process";
import { AbiCoder, ContractFactory, Interface, JsonRpcProvider, getAddress, isAddress } from "ethers";

const RECOVERY_ARTIFACT = "out/GenesisHolderClaimRecovery.sol/GenesisHolderClaimRecovery.json";
const PRIOR_CLAIMANTS = [
  "0x6a86EfA012fEDA64b70112022487fEE22E67d2fb",
  "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174",
];

function address(value, name) {
  if (!value || !isAddress(value)) throw new Error(`${name} must be a valid address`);
  return getAddress(value);
}

function required(value, name) {
  if (value == null || value === "") throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const dryRun = String(process.env.CONFIRM_MAINNET_DEPLOY || "").toLowerCase() !== "yes";
  const rpcUrl = required(process.env.AVALANCHE_MAINNET_RPC_URL, "AVALANCHE_MAINNET_RPC_URL");
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 43114n) throw new Error(`Wrong chain: ${network.chainId}`);

  const release = address(process.env.GENESIS_CLAIM_RELEASE_CONTRACT, "GENESIS_CLAIM_RELEASE_CONTRACT");
  const sale = address(process.env.GENESIS_CLAIM_PRIMARY_SALE, "GENESIS_CLAIM_PRIMARY_SALE");
  const tokenId = BigInt(required(process.env.GENESIS_CLAIM_TOKEN_ID, "GENESIS_CLAIM_TOKEN_ID"));
  const admin = address(process.env.GENESIS_CLAIM_ADMIN, "GENESIS_CLAIM_ADMIN");
  const signer = address(process.env.GENESIS_CLAIM_SIGNER_ADDRESS, "GENESIS_CLAIM_SIGNER_ADDRESS");
  const claimStart = BigInt(required(process.env.GENESIS_CLAIM_START, "GENESIS_CLAIM_START"));
  const publicSaleStart = BigInt(required(process.env.GENESIS_PUBLIC_SALE_START, "GENESIS_PUBLIC_SALE_START"));
  const publicSaleEnd = BigInt(required(process.env.GENESIS_PUBLIC_SALE_END, "GENESIS_PUBLIC_SALE_END"));
  const baseline = BigInt(required(process.env.GENESIS_BASELINE_CLAIMED_SUPPLY, "GENESIS_BASELINE_CLAIMED_SUPPLY"));

  const artifact = JSON.parse(await readFile(RECOVERY_ARTIFACT, "utf8"));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, provider);
  const cfg = {
    releaseContract: release,
    primarySale: sale,
    tokenId,
    allocation: 0n,
    publicAllocation: 0n,
    claimStart,
    claimWindow: 86400n,
    publicSaleStart,
    publicSaleEnd,
    publicPriceWei: 250000000000000000n,
    baselineClaimedSupply: baseline,
    admin,
    signer,
  };
  const prior = PRIOR_CLAIMANTS.map((a) => getAddress(a));
  if (prior.length !== Number(baseline)) throw new Error(`Prior claimants (${prior.length}) must match baseline ${baseline}`);

  const deployTx = await factory.getDeployTransaction(cfg, prior);
  const data = deployTx.data;

  const replacer = (_k, v) => typeof v === 'bigint' ? v.toString() : v;
  console.log(JSON.stringify({
    mode: dryRun ? "DRY_RUN" : "BROADCAST_BLOCKED",
    chainId: 43114,
    contract: "GenesisHolderClaimRecovery",
    artifact: RECOVERY_ARTIFACT,
    constructor: { cfg, priorClaimants: prior },
    deploymentTransaction: { to: null, data, value: "0x0" },
    issuerGrant: {
      note: "Separate transaction. Artist (DEFAULT_ADMIN_ROLE) must grant ISSUER_ROLE to the deployed recovery contract.",
      role: "ISSUER_ROLE",
      grantee: "DEPLOYED_RECOVERY_ADDRESS",
    },
    warnings: dryRun ? ["No broadcast. Set CONFIRM_MAINNET_DEPLOY=yes only after explicit owner authorization."] : ["Broadcast not implemented in this script."],
  }, replacer, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
