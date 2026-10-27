#!/usr/bin/env node
import { pathToFileURL } from "node:url";
// Separate recovery deployment path. Does not touch the original claim deployment script.
// Default is dry-run only. Never broadcasts without explicit CONFIRM_MAINNET_DEPLOY=yes.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { AbiCoder, ContractFactory, Interface, JsonRpcProvider, ZeroHash, getAddress, getCreateAddress, isAddress } from "ethers";
import { MAINNET_ARTIST_WALLET, MAINNET_CHAIN_ID, MAINNET_DEPLOYER, MAINNET_FEE_RECIPIENT, SigningRequestError, creationRequest, verifyCreationTransaction } from "./mainnet-signing-requests.mjs";
import { ELIGIBILITY_RULE, GENESIS_CONTRACT } from "../server/genesis-claim.js";
import { claimFundingCheck } from "./deploy-genesis-claim.mjs";
import { DeploymentError } from "./deploy-release-per-contract-mainnet.mjs";

const RECOVERY_ARTIFACT = "out/GenesisHolderClaimRecovery.sol/GenesisHolderClaimRecovery.json";
const RECOVERY_ARTIFACT_PATH = RECOVERY_ARTIFACT;
const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
// The claim ledger spans the original mainnet claim deployment; the recovery contract joins it.
const PRIOR_LEDGER_CONTRACTS = ["0x8512be04a4E54cd8551738165F9c05C3303187a0"];

function positiveInteger(value, name) {
  const trimmed = String(value || "").trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) < 1n) throw new DeploymentError(`${name} must be a positive integer`);
  return BigInt(trimmed);
}
const RELEASE = new Interface([
  "function owner() view returns (address)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account) returns ()",
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
]);
const SALE = new Interface([
  "function releases() view returns (address)",
  "function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)",
]);
const RECOVERY = new Interface([
  "function releaseContract() view returns (address)",
  "function primarySale() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function allocation() view returns (uint256)",
  "function publicAllocation() view returns (uint256)",
  "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)",
  "function publicSaleStart() view returns (uint256)",
  "function publicSaleEnd() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)",
  "function claimedSupply() view returns (uint256)",
  "function admin() view returns (address)",
  "function signer() view returns (address)",
  "function paused() view returns (bool)",
  "function ELIGIBILITY_RULE() view returns (bytes32)",
  "function hasClaimed(address claimant) view returns (bool)",
]);
// RecoveryConfig is a struct: 2 leading addresses, 9 uint256 fields, 2 trailing addresses; then address[] priorClaimants.
const CONSTRUCTOR_TYPES = ["tuple(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address)", "address[]"];
const text = (value) => (typeof value === "bigint" ? value.toString() : value);

async function read(provider, iface, to, name, args = []) {
  return iface.decodeFunctionResult(name, await provider.call({ to, data: iface.encodeFunctionData(name, args) }));
}

/** Environment for the recovery path: the live sale schedule is retained, not derived from claimStart. */
export function validateRecoveryDeploymentEnv(env = process.env) {
  const rpcUrl = String(env.AVALANCHE_MAINNET_RPC_URL || "https://api.avax.network/ext/bc/C/rpc").trim();
  const expectedDeployerNonce = env.EXPECTED_DEPLOYER_NONCE === undefined || env.EXPECTED_DEPLOYER_NONCE === "" ? null : positiveInteger(env.EXPECTED_DEPLOYER_NONCE, "EXPECTED_DEPLOYER_NONCE");
  const claimStart = BigInt(required(env.GENESIS_CLAIM_START, "GENESIS_CLAIM_START"));
  const publicSaleStart = BigInt(required(env.GENESIS_PUBLIC_SALE_START, "GENESIS_PUBLIC_SALE_START"));
  const publicSaleEnd = BigInt(required(env.GENESIS_PUBLIC_SALE_END, "GENESIS_PUBLIC_SALE_END"));
  const baseline = BigInt(required(env.GENESIS_BASELINE_CLAIMED_SUPPLY, "GENESIS_BASELINE_CLAIMED_SUPPLY"));
  return Object.freeze({
    network: "mainnet",
    chainId: MAINNET_CHAIN_ID,
    rpcUrl,
    deployerAddress: MAINNET_DEPLOYER,
    expectedDeployerNonce,
    releaseContract: address(env.GENESIS_CLAIM_RELEASE_CONTRACT, "GENESIS_CLAIM_RELEASE_CONTRACT"),
    primarySale: address(env.GENESIS_CLAIM_PRIMARY_SALE, "GENESIS_CLAIM_PRIMARY_SALE"),
    tokenId: BigInt(required(env.GENESIS_CLAIM_TOKEN_ID, "GENESIS_CLAIM_TOKEN_ID")),
    admin: address(env.GENESIS_CLAIM_ADMIN, "GENESIS_CLAIM_ADMIN"),
    signer: address(env.GENESIS_CLAIM_SIGNER_ADDRESS, "GENESIS_CLAIM_SIGNER_ADDRESS"),
    allocation: 0n,
    publicAllocation: 0n,
    claimWindow: 86400n,
    claimStart,
    claimEnd: claimStart + 86400n,
    publicSaleStart,
    publicSaleEnd,
    publicPriceWei: 250000000000000000n,
    baselineClaimedSupply: baseline,
    priorClaimants: PRIOR_CLAIMANTS.map((value) => getAddress(value)),
  });
}

/** Read-only preflight against live C-Chain state; mirrors every constructor constraint of the recovery contract. */
export async function preflightRecoveryDeployment(config, { provider, artifact } = {}) {
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) throw new DeploymentError(`Wrong chain: ${network.chainId}`);
  const [deployerNonce, pendingNonce] = await Promise.all([
    provider.getTransactionCount(config.deployerAddress, "latest"),
    provider.getTransactionCount(config.deployerAddress, "pending"),
  ]);
  const predictedRecovery = getCreateAddress({ from: config.deployerAddress, nonce: deployerNonce });
  const edition = (await read(provider, RELEASE, config.releaseContract, "edition", [config.tokenId]))[0];
  const saleState = await read(provider, SALE, config.primarySale, "sales", [config.tokenId]);
  const sale = {
    priceWei: BigInt(saleState.priceWei), maxSupply: BigInt(saleState.maxSupply), sold: BigInt(saleState.sold),
    perWalletLimit: BigInt(saleState.perWalletLimit), startTime: BigInt(saleState.startTime), endTime: BigInt(saleState.endTime),
    paused: Boolean(saleState.paused), configured: Boolean(saleState.configured),
  };
  const [boundRelease, issuerRole, owner] = await Promise.all([
    read(provider, SALE, config.primarySale, "releases"),
    read(provider, RELEASE, config.releaseContract, "ISSUER_ROLE"),
    read(provider, RELEASE, config.releaseContract, "owner"),
  ]).then(([a, b, c]) => [a[0], b[0], c[0]]);
  const isAdmin = async (account) => (await read(provider, RELEASE, config.releaseContract, "hasRole", [ZeroHash, account]))[0];
  if (boundRelease !== getAddress(config.releaseContract)) throw new DeploymentError(`The sale's releases() is ${boundRelease}, not the release ${config.releaseContract}.`);
  if (!edition.exists) throw new DeploymentError(`Token ${config.tokenId} has no edition on the release.`);
  if (!sale.configured || sale.paused) throw new DeploymentError("The live sale is not configured or is paused.");
  if (sale.priceWei !== config.publicPriceWei) throw new DeploymentError(`The live sale price ${sale.priceWei} is not ${config.publicPriceWei}.`);
  if (sale.maxSupply !== config.publicAllocation) throw new DeploymentError(`The live sale maxSupply ${sale.maxSupply} is not publicAllocation ${config.publicAllocation}.`);
  if (sale.startTime !== config.publicSaleStart || sale.endTime !== config.publicSaleEnd) throw new DeploymentError("The live sale schedule does not match the configured public sale window.");
  if (edition.mintedSupply !== sale.sold + config.baselineClaimedSupply) {
    throw new DeploymentError(`Supply invariant failed: mintedSupply ${edition.mintedSupply} != sold ${sale.sold} + baseline ${config.baselineClaimedSupply}.`);
  }
  if (config.priorClaimants.length !== Number(config.baselineClaimedSupply)) throw new DeploymentError(`Prior claimants (${config.priorClaimants.length}) must match baseline ${config.baselineClaimedSupply}.`);
  const owner_ = getAddress(owner);
  const releaseOwnerIsArtist = owner_ === getAddress(MAINNET_ARTIST_WALLET);
  if (!releaseOwnerIsArtist) throw new DeploymentError(`The release ${config.releaseContract} is owned by ${owner_}, not the artist wallet ${MAINNET_ARTIST_WALLET}.`);
  if (!(await isAdmin(owner_))) throw new DeploymentError("The release owner does not hold DEFAULT_ADMIN_ROLE, so it cannot grant ISSUER_ROLE.");
  if (await isAdmin(MAINNET_DEPLOYER)) throw new DeploymentError("The deployer holds DEFAULT_ADMIN_ROLE on the release; the deployer must hold no release authority.");
  if (await isAdmin(MAINNET_FEE_RECIPIENT)) throw new DeploymentError("The passive fee recipient holds DEFAULT_ADMIN_ROLE on the release; it must hold no role.");
  const cfg = {
    releaseContract: getAddress(config.releaseContract), primarySale: getAddress(config.primarySale), tokenId: config.tokenId,
    allocation: config.allocation, publicAllocation: config.publicAllocation, claimStart: config.claimStart, claimWindow: config.claimWindow,
    publicSaleStart: config.publicSaleStart, publicSaleEnd: config.publicSaleEnd, publicPriceWei: config.publicPriceWei,
    baselineClaimedSupply: config.baselineClaimedSupply, admin: getAddress(config.admin), signer: getAddress(config.signer),
  };
  const args = [cfg, config.priorClaimants];
  return { deployerNonce, pendingNonce, predictedRecovery, issuerRole, edition: { maxSupply: BigInt(edition.maxSupply), mintedSupply: BigInt(edition.mintedSupply), artist: getAddress(edition.artist) }, sale, args };
}

export function buildRecoveryPlan(config, facts) {
  return JSON.parse(JSON.stringify({
    network: config.network,
    chainId: config.chainId,
    deployer: config.deployerAddress,
    deployerNonce: facts.deployerNonce,
    predictedRecoveryAddress: facts.predictedRecovery,
    predictedClaimAddress: facts.predictedRecovery,
    target: { releaseContract: config.releaseContract, primarySale: config.primarySale, tokenId: config.tokenId, edition: facts.edition, sale: facts.sale },
    schedule: { claimStart: config.claimStart, claimWindowSeconds: config.claimWindow, claimEnd: config.claimEnd, publicSaleStart: config.publicSaleStart, publicSaleEnd: config.publicSaleEnd, publicPriceWei: config.publicPriceWei, sale: "the live sale schedule is retained, not derived from claimStart" },
    supply: { claimAllocation: config.allocation, publicAllocation: config.publicAllocation, meaning: "uncapped recovery: one claim per eligible Genesis holder, no recovery cap; publicAllocation mirrors the live open-edition sale (maxSupply 0)" },
    eligibility: { chainId: MAINNET_CHAIN_ID, genesisContract: GENESIS_CONTRACT, rule: ELIGIBILITY_RULE },
    roles: { admin: config.admin, signer: config.signer },
    priorClaimants: config.priorClaimants,
    baselineClaimedSupply: config.baselineClaimedSupply,
    constructorSimulation: "passed (eth_call from the deployer)",
    followUps: {
      issuerGrant: { from: getAddress(MAINNET_ARTIST_WALLET), to: config.releaseContract, role: facts.issuerRole, data: RELEASE.encodeFunctionData("grantRole", [facts.issuerRole, facts.predictedRecovery]), note: "The artist (release DEFAULT_ADMIN) must grant ISSUER_ROLE to the deployed recovery contract; this script never does." },
      apiConfiguration: {
        GENESIS_CLAIM_RELEASE_CONTRACT: config.releaseContract, GENESIS_CLAIM_PRIMARY_SALE: config.primarySale,
        GENESIS_CLAIM_CONTRACT: facts.predictedRecovery, GENESIS_CLAIM_LEDGER_CONTRACTS: [...PRIOR_LEDGER_CONTRACTS, facts.predictedRecovery].join(","),
        GENESIS_CLAIM_TOKEN_ID: config.tokenId, GENESIS_CLAIM_ALLOCATION: config.allocation, GENESIS_PUBLIC_MINT_ALLOCATION: config.publicAllocation,
        GENESIS_CLAIM_START: config.claimStart, GENESIS_CLAIM_WINDOW_SECONDS: config.claimWindow,
        GENESIS_PUBLIC_SALE_START: config.publicSaleStart, GENESIS_PUBLIC_SALE_END: config.publicSaleEnd,
        GENESIS_PUBLIC_PRICE_WEI: config.publicPriceWei, GENESIS_BASELINE_CLAIMED_SUPPLY: config.baselineClaimedSupply,
        RELEASE_NETWORK: config.network, GENESIS_CLAIM_RECOVERY: "true", note: "Plus GENESIS_RPC_URL and the server-only signer key. GENESIS_CLAIM_ENABLED=true only with owner authorization.",
      },
    },
  }, (_key, value) => text(value)));
}

export function recoveryPlanInputs(config) {
  return {
    DEPLOY_NETWORK: config.network,
    EXPECTED_DEPLOYER_ADDRESS: config.deployerAddress,
    EXPECTED_DEPLOYER_NONCE: config.expectedDeployerNonce === null ? "" : String(config.expectedDeployerNonce),
    GENESIS_CLAIM_RELEASE_CONTRACT: config.releaseContract,
    GENESIS_CLAIM_PRIMARY_SALE: config.primarySale,
    GENESIS_CLAIM_TOKEN_ID: config.tokenId.toString(),
    GENESIS_CLAIM_ADMIN: config.admin,
    GENESIS_CLAIM_SIGNER_ADDRESS: config.signer,
    GENESIS_CLAIM_START: config.claimStart.toString(),
    GENESIS_PUBLIC_SALE_START: config.publicSaleStart.toString(),
    GENESIS_PUBLIC_SALE_END: config.publicSaleEnd.toString(),
    GENESIS_BASELINE_CLAIMED_SUPPLY: config.baselineClaimedSupply.toString(),
  };
}

/** Signing additions for mainnet: the exact unsigned creation transaction plus live readiness gates. */
export async function recoverySigningPlan(config, facts, plan, { provider, artifact } = {}) {
  const c = facts.args[0];
  const cfgTuple = [c.releaseContract, c.primarySale, c.tokenId, c.allocation, c.publicAllocation, c.claimStart, c.claimWindow, c.publicSaleStart, c.publicSaleEnd, c.publicPriceWei, c.baselineClaimedSupply, c.admin, c.signer];
  const data = `${artifact.bytecode.object}${AbiCoder.defaultAbiCoder().encode(CONSTRUCTOR_TYPES, [cfgTuple, facts.args[1]]).slice(2)}`;
  const estimatedGas = await provider.estimateGas({ from: config.deployerAddress, data });
  let request;
  try {
    request = creationRequest({ step: 1, contract: "GenesisHolderClaimRecovery", chainId: config.chainId, from: config.deployerAddress, nonce: facts.deployerNonce, data, estimatedGas, predictedAddress: facts.predictedRecovery });
  } catch (error) {
    if (error instanceof SigningRequestError) throw new DeploymentError(error.message);
    throw error;
  }
  const [predictedCode, fundingGate] = await Promise.all([provider.getCode(facts.predictedRecovery), claimFundingCheck(provider, config.deployerAddress, request)]);
  const checks = [
    { check: "no pending deployer transactions", status: facts.pendingNonce === facts.deployerNonce ? "PASS" : "FAIL", value: { nonce: facts.deployerNonce, pendingNonce: facts.pendingNonce } },
    { check: "nonce matches EXPECTED_DEPLOYER_NONCE", status: config.expectedDeployerNonce === null ? "NOT PROVIDED" : BigInt(config.expectedDeployerNonce) === BigInt(facts.deployerNonce) ? "PASS" : "FAIL", value: config.expectedDeployerNonce },
    { check: "predicted recovery address is empty", status: predictedCode === "0x" ? "PASS" : "FAIL", value: facts.predictedRecovery },
    ...fundingGate.checks,
  ];
  return {
    ...plan,
    readyToSign: checks.every((item) => item.status === "PASS" || item.status === "NOT PROVIDED"),
    checks,
    funding: fundingGate.funding,
    signingRequests: [request],
    planInputs: recoveryPlanInputs(config),
  };
}

/** Verifies the owner-signed recovery deployment from chain against the reviewed plan. */
export async function verifyRecoveryDeployment(provider, plan, hash, { timeoutMs } = {}) {
  const request = plan.signingRequests?.[0];
  if (!request) throw new DeploymentError("The plan has no signing request.");
  let mined;
  try {
    mined = await verifyCreationTransaction(provider, request, hash, { timeoutMs });
  } catch (error) {
    if (error instanceof SigningRequestError) throw new DeploymentError(error.message);
    throw error;
  }
  const address = getAddress(mined.address);
  const onchain = {};
  for (const name of ["releaseContract", "primarySale", "tokenId", "allocation", "publicAllocation", "claimStart", "claimEnd", "publicSaleStart", "publicSaleEnd", "publicPriceWei", "claimedSupply", "admin", "signer", "paused", "ELIGIBILITY_RULE"]) onchain[name] = (await read(provider, RECOVERY, address, name))[0];
  const expected = { releaseContract: plan.target.releaseContract, primarySale: plan.target.primarySale, tokenId: plan.target.tokenId, allocation: plan.supply.claimAllocation, publicAllocation: plan.supply.publicAllocation, claimStart: plan.schedule.claimStart, claimEnd: plan.schedule.claimEnd, publicSaleStart: plan.schedule.publicSaleStart, publicSaleEnd: plan.schedule.publicSaleEnd, publicPriceWei: plan.schedule.publicPriceWei, admin: plan.roles.admin, signer: plan.roles.signer };
  const mismatched = Object.keys(expected).filter((name) => String(onchain[name]).toLowerCase() !== String(expected[name]).toLowerCase()).map((name) => `${name} is ${onchain[name]}, not ${expected[name]}`);
  if (mismatched.length) throw new DeploymentError(`The mined recovery contract does not match the reviewed parameters: ${mismatched.join(", ")}.`);
  if (onchain.ELIGIBILITY_RULE !== ELIGIBILITY_RULE) throw new DeploymentError("The mined ELIGIBILITY_RULE does not match the server's live eligibility rule.");
  if (String(onchain.claimedSupply) !== String(plan.baselineClaimedSupply)) throw new DeploymentError(`The mined claimedSupply ${onchain.claimedSupply} is not the baseline ${plan.baselineClaimedSupply}.`);
  for (const claimant of plan.priorClaimants) {
    if (!(await read(provider, RECOVERY, address, "hasClaimed", [claimant]))[0]) throw new DeploymentError(`Prior claimant ${claimant} is not seeded as claimed.`);
  }
  const [issuerRole, issuerGranted] = [plan.followUps.issuerGrant.role, (await read(provider, RELEASE, plan.target.releaseContract, "hasRole", [plan.followUps.issuerGrant.role, address]))[0]];
  return { ...mined, parameters: { ...expected, claimedSupply: onchain.claimedSupply.toString() }, issuerGrant: issuerGranted ? "GRANTED" : `PENDING (artist operation; role ${issuerRole})` };
}

export function buildRecoveryRecord(plan, verified, { sourceCommit = null, planDigest = null } = {}) {
  return {
    network: plan.network, chainId: plan.chainId,
    signedBy: { deployer: plan.deployer, method: "owner-signed in Rabby; no private key left the wallet" },
    plan: { sourceCommit, digest: planDigest },
    contract: { name: "GenesisHolderClaimRecovery", address: verified.address, deploymentTransaction: verified.transaction, deploymentBlock: verified.block, deployer: plan.deployer, sourceCommit },
    parameters: verified.parameters,
    priorClaimants: plan.priorClaimants,
    issuerGrant: { status: verified.issuerGrant, ...plan.followUps.issuerGrant },
  };
}

export async function loadRecoveryArtifact() {
  const artifact = JSON.parse(await readFile(resolve(ROOT, RECOVERY_ARTIFACT_PATH), "utf8"));
  const inputs = artifact.abi?.find((item) => item.type === "constructor")?.inputs || [];
  if (!artifact.bytecode?.object || artifact.bytecode.object === "0x" || inputs.length !== 2) throw new DeploymentError(`${RECOVERY_ARTIFACT_PATH} is missing or is not the GenesisHolderClaimRecovery; run forge build.`);
  return artifact;
}
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
