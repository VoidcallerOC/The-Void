import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AbiCoder, ContractFactory, Interface, JsonRpcProvider, Wallet, ZeroHash, getAddress, getCreateAddress, isAddress } from "ethers";
import { DeploymentError, assertRpcChainId } from "./deploy-release-factory-v3.mjs";
import mainnetReleaseManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };
import { checkClaimState } from "./claim-onchain-checks.mjs";
import { MAINNET_DEPLOYER, SigningRequestError, assertDefinedDeployer, assertNoPrivateKeyInEnv, creationRequest, verifyCreationTransaction } from "./mainnet-signing-requests.mjs";
import { CLAIM_WINDOW_SECONDS, GENESIS_CHAIN_ID, GenesisClaimConfigurationError, LEGACY_FUJI_SINGLETON, ELIGIBILITY_RULE, ELIGIBILITY_RULE_TEXT, GENESIS_CONTRACT, PUBLIC_WINDOW_SECONDS, claimSchedule } from "../server/genesis-claim.js";

// GenesisHolderClaim for one existing release token, on Fuji (accelerated test windows allowed) or
// C-Chain mainnet (production 24 hours / 7 days at 0.25 AVAX only, enforced here, by the API and
// by the contract). The token's VoidPrimarySale must already be
// configured as the public phase (open at claimStart + 24 h, close 7 days later, at the public price),
// and the edition must have no mints other than sale purchases. Everything is read-only until a
// broadcast is explicitly confirmed; the default path is a dry run that simulates the constructor.
// The script never grants roles, edits config/ or touches the API: those follow-ups are printed.
// On mainnet it never signs or reads a key: the plan carries the exact unsigned creation transaction,
// which the owner signs in Rabby with the defined deployer (scripts/mainnet-owner-signing.mjs), and
// verifyClaimDeployment checks the mined claim from chain. The ISSUER_ROLE grant is prepared for the
// release's verified DEFAULT_ADMIN_ROLE holder (the artist wallet), never the deployer.
export const FUJI_CHAIN_ID = 43113;
export const CLAIM_ARTIFACT_PATH = "out/GenesisHolderClaim.sol/GenesisHolderClaim.json";
export const CLAIM_NETWORKS = Object.freeze({
  fuji: Object.freeze({ chainId: FUJI_CHAIN_ID, rpcEnv: "AVALANCHE_FUJI_RPC_URL", confirmEnv: "CONFIRM_FUJI_DEPLOY" }),
  mainnet: Object.freeze({ chainId: GENESIS_CHAIN_ID, rpcEnv: "AVALANCHE_MAINNET_RPC_URL", confirmEnv: "CONFIRM_MAINNET_DEPLOY" }),
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The Genesis collection owner and Forgive & Forget artist wallet.
const MAINNET_ARTIST_WALLET = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
// Seconds a broadcast needs before claims open: to be mined and for the artist to grant ISSUER_ROLE.
export const MINIMUM_LEAD_SECONDS = 600n;

const RELEASE = new Interface([
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
  "function mintEndOf(uint256 tokenId) view returns (uint64)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function grantRole(bytes32 role,address account)",
  "function owner() view returns (address)",
]);
const SALE = new Interface([
  "function releases() view returns (address)",
  "function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)",
]);
const CLAIM = new Interface([
  "function releaseContract() view returns (address)", "function primarySale() view returns (address)", "function tokenId() view returns (uint256)",
  "function allocation() view returns (uint256)", "function publicAllocation() view returns (uint256)", "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)", "function publicSaleEnd() view returns (uint256)", "function publicPriceWei() view returns (uint256)",
  "function claimWindow() view returns (uint256)", "function publicWindow() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)", "function admin() view returns (address)", "function signer() view returns (address)",
]);
const CONSTRUCTOR_TYPES = ["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "address", "address"];

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new DeploymentError(`${name} is required.`);
  return text;
}

function address(value, name) {
  const text = required(value, name);
  if (!isAddress(text) || getAddress(text) === "0x0000000000000000000000000000000000000000") throw new DeploymentError(`${name} must be a non-zero EVM address.`);
  return getAddress(text);
}

function whole(value, name, { positive = false, fallback } = {}) {
  const text = String(value ?? fallback ?? "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text) || (positive && text === "0")) throw new DeploymentError(`${name} must be a ${positive ? "positive" : "non-negative"} whole number.`);
  return BigInt(text);
}

function httpUrl(value, name) {
  const text = required(value, name);
  if (!/^https?:\/\//i.test(text) || /@/.test(text)) throw new DeploymentError(`${name} must be an HTTP(S) URL without embedded credentials.`);
  return text;
}

// Mainnet keeps the deployer, artist, claim signer and the passive platform fee recipient (the
// owner's Nano S Plus) as separate roles: the fee recipient is never a claim admin or signer, and the
// automated voucher signer is a dedicated key used for nothing else.
export const MAINNET_FEE_RECIPIENT = getAddress(mainnetReleaseManifest.platformRecipient);
export function assertMainnetClaimRoles({ admin, signer, deployer }) {
  if (admin === MAINNET_FEE_RECIPIENT || signer === MAINNET_FEE_RECIPIENT) throw new DeploymentError("The platform fee recipient is a passive wallet; it may not be the claim admin or the voucher signer.");
  if (signer === admin) throw new DeploymentError("The voucher signer must be a dedicated key, not the claim admin.");
  if (signer === deployer) throw new DeploymentError("The voucher signer must be a dedicated key, not the deployer.");
  if (signer === getAddress(MAINNET_ARTIST_WALLET)) throw new DeploymentError("The voucher signer must be a dedicated key, not the artist wallet.");
}

export function validateClaimDeploymentEnv(env = process.env) {
  const network = String(env.DEPLOY_NETWORK || "").trim().toLowerCase();
  const target = CLAIM_NETWORKS[network];
  if (!target) throw new DeploymentError('DEPLOY_NETWORK must be exactly "fuji" or "mainnet".');
  if (network === "mainnet") {
    // Mainnet never reads a key and never broadcasts from a script; the owner signs in Rabby.
    try {
      assertNoPrivateKeyInEnv(env, "The mainnet Genesis claim plan");
      assertDefinedDeployer(env.EXPECTED_DEPLOYER_ADDRESS);
    } catch (error) {
      throw new DeploymentError(error.message);
    }
    if (String(env.BROADCAST_DEPLOYMENT || "").trim().toLowerCase() === "yes") {
      throw new DeploymentError("Mainnet is never broadcast from this script. The owner signs the planned transaction in Rabby: npm run sign:mainnet (deploy/mainnet/OWNER-SIGNING.md).");
    }
  }
  const rpcUrl = httpUrl(env[target.rpcEnv], target.rpcEnv);
  const genesisRpcUrl = httpUrl(env.GENESIS_RPC_URL, "GENESIS_RPC_URL");
  // A dry run can plan from EXPECTED_DEPLOYER_ADDRESS alone, so the key reaches only an approved broadcast.
  const deployerPrivateKey = String(env.DEPLOYER_PRIVATE_KEY ?? "").trim() || null;
  if (deployerPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(deployerPrivateKey)) throw new DeploymentError("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key.");
  const releaseContract = address(env.GENESIS_CLAIM_RELEASE_CONTRACT, "GENESIS_CLAIM_RELEASE_CONTRACT");
  if (releaseContract === getAddress(LEGACY_FUJI_SINGLETON)) throw new DeploymentError("The legacy Fuji V2 singleton may not be the claim release target.");
  const primarySale = address(env.GENESIS_CLAIM_PRIMARY_SALE, "GENESIS_CLAIM_PRIMARY_SALE");
  if (primarySale === releaseContract) throw new DeploymentError("GENESIS_CLAIM_PRIMARY_SALE must differ from the release contract.");
  const openText = String(env.GENESIS_EXPECT_OPEN_EDITION ?? "yes").trim().toLowerCase();
  if (openText !== "yes" && openText !== "no") throw new DeploymentError("GENESIS_EXPECT_OPEN_EDITION must be yes or no.");
  const claimStart = whole(env.GENESIS_CLAIM_START, "GENESIS_CLAIM_START", { positive: true });
  const publicPriceWei = whole(env.GENESIS_PUBLIC_PRICE_WEI, "GENESIS_PUBLIC_PRICE_WEI", { positive: true });
  let schedule;
  try {
    schedule = claimSchedule({
      destinationChainId: target.chainId,
      claimWindow: whole(env.GENESIS_CLAIM_WINDOW_SECONDS, "GENESIS_CLAIM_WINDOW_SECONDS", { positive: true, fallback: CLAIM_WINDOW_SECONDS.toString() }),
      publicWindow: whole(env.GENESIS_PUBLIC_WINDOW_SECONDS, "GENESIS_PUBLIC_WINDOW_SECONDS", { positive: true, fallback: PUBLIC_WINDOW_SECONDS.toString() }),
      publicPriceWei,
    });
  } catch (error) {
    if (error instanceof GenesisClaimConfigurationError) throw new DeploymentError(error.message);
    throw error;
  }
  const broadcast = String(env.BROADCAST_DEPLOYMENT || "").trim().toLowerCase() === "yes";
  if (broadcast && String(env[target.confirmEnv] || "").trim() !== "yes") throw new DeploymentError(`Broadcast requires ${target.confirmEnv}=yes.`);
  const expectedText = String(env.EXPECTED_DEPLOYER_ADDRESS || "").trim();
  if (broadcast && !deployerPrivateKey) throw new DeploymentError("DEPLOYER_PRIVATE_KEY is required to broadcast.");
  if (broadcast && !expectedText) throw new DeploymentError("Broadcast requires EXPECTED_DEPLOYER_ADDRESS, the deployer address the owner reviewed.");
  if (!deployerPrivateKey && !expectedText) throw new DeploymentError("DEPLOYER_PRIVATE_KEY or EXPECTED_DEPLOYER_ADDRESS is required.");
  const deployerAddress = deployerPrivateKey ? new Wallet(deployerPrivateKey).address : address(expectedText, "EXPECTED_DEPLOYER_ADDRESS");
  if (expectedText && address(expectedText, "EXPECTED_DEPLOYER_ADDRESS") !== deployerAddress) throw new DeploymentError("DEPLOYER_PRIVATE_KEY does not belong to EXPECTED_DEPLOYER_ADDRESS.");
  const nonceText = String(env.EXPECTED_DEPLOYER_NONCE ?? "").trim();
  if (nonceText && !/^(0|[1-9][0-9]{0,15})$/.test(nonceText)) throw new DeploymentError("EXPECTED_DEPLOYER_NONCE must be a non-negative whole number.");
  if (broadcast && !nonceText) throw new DeploymentError("Broadcast requires EXPECTED_DEPLOYER_NONCE, the deployer nonce printed by the reviewed dry run.");
  const admin = address(env.GENESIS_CLAIM_ADMIN, "GENESIS_CLAIM_ADMIN");
  const signer = address(env.GENESIS_CLAIM_SIGNER_ADDRESS, "GENESIS_CLAIM_SIGNER_ADDRESS");
  if (network === "mainnet") assertMainnetClaimRoles({ admin, signer, deployer: deployerAddress });
  return Object.freeze({
    network,
    chainId: target.chainId,
    rpcUrl,
    genesisRpcUrl,
    deployerPrivateKey,
    deployerAddress,
    releaseContract,
    primarySale,
    tokenId: whole(env.GENESIS_CLAIM_TOKEN_ID, "GENESIS_CLAIM_TOKEN_ID"),
    // Open edition: no reserved claim allocation and no public cap. Both default to 0 (uncapped).
    allocation: whole(env.GENESIS_CLAIM_ALLOCATION, "GENESIS_CLAIM_ALLOCATION", { fallback: "0" }),
    publicAllocation: whole(env.GENESIS_PUBLIC_MINT_ALLOCATION, "GENESIS_PUBLIC_MINT_ALLOCATION", { fallback: "0" }),
    claimStart,
    claimWindow: schedule.claimWindow,
    publicWindow: schedule.publicWindow,
    claimEnd: claimStart + schedule.claimWindow,
    publicSaleEnd: claimStart + schedule.claimWindow + schedule.publicWindow - 1n,
    publicPriceWei,
    expectOpenEdition: openText === "yes",
    admin,
    signer,
    broadcast,
    expectedDeployerNonce: nonceText ? Number(nonceText) : null,
  });
}

export function constructorArgs(config) {
  return [config.releaseContract, config.primarySale, config.tokenId, config.allocation, config.publicAllocation, config.claimStart, config.claimWindow, config.publicWindow, config.publicPriceWei, config.admin, config.signer];
}

async function read(provider, iface, to, name, args = []) {
  const data = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
  return iface.decodeFunctionResult(name, data);
}

/**
 * Every read-only check the deployment depends on. Returns the facts a reviewer needs; throws a
 * DeploymentError naming the first refusal. Nothing here signs or sends a transaction.
 */
export async function preflightClaimDeployment(config, { provider, genesisProvider, artifact }) {
  await assertRpcChainId(provider, config.chainId);
  await assertRpcChainId(genesisProvider, GENESIS_CHAIN_ID);
  // Eligibility is read live from the Genesis collection when vouchers are signed; it must be reachable.
  const genesisCode = await genesisProvider.getCode(GENESIS_CONTRACT);
  if (!genesisCode || genesisCode === "0x") throw new DeploymentError(`The Genesis collection ${GENESIS_CONTRACT} has no code on C-Chain; live ownership cannot be verified.`);
  const eligibility = Object.freeze({ text: ELIGIBILITY_RULE_TEXT, rule: ELIGIBILITY_RULE, source: "live balanceOf on C-Chain at voucher request" });

  for (const [name, target] of [["release", config.releaseContract], ["primary sale", config.primarySale]]) {
    const code = await provider.getCode(target);
    if (!code || code === "0x") throw new DeploymentError(`The ${name} ${target} has no code on chain ${config.chainId}.`);
  }
  let maxSupply;
  let edition;
  try {
    [maxSupply] = await read(provider, RELEASE, config.releaseContract, "maxSupplyOf", [config.tokenId]);
    [edition] = await read(provider, RELEASE, config.releaseContract, "edition", [config.tokenId]);
  } catch {
    throw new DeploymentError(`Token ${config.tokenId} does not exist on release ${config.releaseContract}; create the edition first.`);
  }
  if (!edition.exists) throw new DeploymentError(`Token ${config.tokenId} does not exist on release ${config.releaseContract}.`);
  if (config.expectOpenEdition && BigInt(maxSupply) !== 0n) throw new DeploymentError(`Token ${config.tokenId} is a capped edition (maxSupply ${maxSupply}), not the uncapped open edition this claim requires.`);
  let mintEnd = null;
  try { [mintEnd] = await read(provider, RELEASE, config.releaseContract, "mintEndOf", [config.tokenId]); } catch { mintEnd = null; }
  if (mintEnd !== null && BigInt(mintEnd) !== 0n && BigInt(mintEnd) !== config.publicSaleEnd) throw new DeploymentError(`The edition's mint deadline ${mintEnd} is neither unset nor the end of the public window ${config.publicSaleEnd}.`);

  const [bound] = await read(provider, SALE, config.primarySale, "releases");
  if (getAddress(bound) !== config.releaseContract) throw new DeploymentError(`The primary sale ${config.primarySale} sells release ${getAddress(bound)}, not ${config.releaseContract}.`);
  const sale = await read(provider, SALE, config.primarySale, "sales", [config.tokenId]);
  const expected = { configured: true, priceWei: config.publicPriceWei, maxSupply: config.publicAllocation, startTime: config.claimEnd, endTime: config.publicSaleEnd };
  if (!sale.configured) throw new DeploymentError("The token's primary sale is not configured. Configure the public phase before deploying the claim.");
  for (const field of ["priceWei", "maxSupply", "startTime", "endTime"]) {
    if (BigInt(sale[field]) !== expected[field]) throw new DeploymentError(`Sale ${field} is ${sale[field]}, expected ${expected[field]} (public phase: opens at claimStart + ${config.claimWindow}s, lasts ${config.publicWindow}s, at the public price).`);
  }
  if (BigInt(edition.mintedSupply) !== BigInt(sale.sold)) throw new DeploymentError(`The edition has ${edition.mintedSupply} minted but the sale sold ${sale.sold}: another mint path exists, so claim accounting would fail.`);

  const [latest, deployerNonce, pendingNonce] = await Promise.all([provider.getBlock("latest"), provider.getTransactionCount(config.deployerAddress, "latest"), provider.getTransactionCount(config.deployerAddress, "pending")]);
  const now = BigInt(latest.timestamp);
  if (config.claimStart < now + MINIMUM_LEAD_SECONDS) throw new DeploymentError(`GENESIS_CLAIM_START ${config.claimStart} is less than ${MINIMUM_LEAD_SECONDS} seconds after the latest block (${now}); choose a later start.`);

  const [issuerRole] = await read(provider, RELEASE, config.releaseContract, "ISSUER_ROLE");
  const predictedClaim = getCreateAddress({ from: config.deployerAddress, nonce: deployerNonce });
  const args = constructorArgs(config);
  // The constructor reads the release and sale and reverts on any mismatch; simulate it now.
  const initcode = `${artifact.bytecode.object}${AbiCoder.defaultAbiCoder().encode(CONSTRUCTOR_TYPES, args).slice(2)}`;
  try {
    await provider.call({ from: config.deployerAddress, data: initcode });
  } catch (error) {
    throw new DeploymentError(`Simulating the GenesisHolderClaim constructor reverted${error?.shortMessage ? ` (${error.shortMessage})` : ""}; nothing was broadcast.`);
  }
  return Object.freeze({
    fujiBlock: latest.number,
    fujiTime: now,
    deployerNonce,
    pendingNonce,
    predictedClaim,
    issuerRole,
    eligibility,
    edition: { maxSupply: BigInt(maxSupply), mintedSupply: BigInt(edition.mintedSupply), artist: getAddress(edition.artist), mintEnd: mintEnd === null ? null : BigInt(mintEnd) },
    sale: { priceWei: BigInt(sale.priceWei), maxSupply: BigInt(sale.maxSupply), sold: BigInt(sale.sold), perWalletLimit: BigInt(sale.perWalletLimit), startTime: BigInt(sale.startTime), endTime: BigInt(sale.endTime), paused: Boolean(sale.paused) },
    args,
  });
}

const text = (value) => (typeof value === "bigint" ? value.toString() : value);

export function buildPlan(config, facts) {
  return JSON.parse(JSON.stringify({
    network: config.network,
    chainId: config.chainId,
    deployer: config.deployerAddress,
    deployerNonce: facts.deployerNonce,
    predictedClaimAddress: facts.predictedClaim,
    target: { releaseContract: config.releaseContract, primarySale: config.primarySale, tokenId: config.tokenId, edition: facts.edition, sale: facts.sale },
    schedule: { claimStart: config.claimStart, claimWindowSeconds: config.claimWindow, claimEnd: config.claimEnd, publicSaleOpens: config.claimEnd, publicWindowSeconds: config.publicWindow, publicSaleEnd: config.publicSaleEnd, publicPriceWei: config.publicPriceWei, sale: `configureSale(tokenId, ${config.publicPriceWei}, ${config.publicAllocation}, 0, ${config.claimEnd}, ${config.publicSaleEnd}, false)` },
    supply: { claimAllocation: config.allocation, publicAllocation: config.publicAllocation, meaning: config.allocation === 0n && config.publicAllocation === 0n ? "uncapped open edition: one claim per eligible wallet, no sale cap" : "finite allocations" },
    eligibility: { chainId: GENESIS_CHAIN_ID, genesisContract: GENESIS_CONTRACT, source: facts.eligibility.source, ruleText: facts.eligibility.text, rule: facts.eligibility.rule },
    roles: { admin: config.admin, signer: config.signer },
    constructorSimulation: "passed (eth_call from the deployer)",
    followUps: {
      issuerGrant: { from: facts.edition.artist, to: config.releaseContract, data: RELEASE.encodeFunctionData("grantRole", [facts.issuerRole, facts.predictedClaim]), note: "The artist (release admin) must grant ISSUER_ROLE to the claim before claimStart; this script never does." },
      apiConfiguration: {
        GENESIS_CLAIM_RELEASE_CONTRACT: config.releaseContract, GENESIS_CLAIM_PRIMARY_SALE: config.primarySale, GENESIS_CLAIM_CONTRACT: facts.predictedClaim,
        GENESIS_CLAIM_TOKEN_ID: config.tokenId, GENESIS_CLAIM_ALLOCATION: config.allocation, GENESIS_PUBLIC_MINT_ALLOCATION: config.publicAllocation,
        GENESIS_CLAIM_START: config.claimStart, GENESIS_CLAIM_WINDOW_SECONDS: config.claimWindow, GENESIS_PUBLIC_WINDOW_SECONDS: config.publicWindow,
        GENESIS_PUBLIC_PRICE_WEI: config.publicPriceWei, RELEASE_NETWORK: config.network, note: "Plus GENESIS_RPC_URL, GENESIS_DESTINATION_RPC_URL and the server-only GENESIS_CLAIM_SIGNER_PRIVATE_KEY for the signer above. GENESIS_CLAIM_ENABLED=true only with owner authorization.",
      },
    },
  }, (_key, value) => text(value)));
}

/** The non-secret inputs that reproduce a mainnet plan, recorded in it so the signing tool can re-plan. */
export function claimPlanInputs(config) {
  return {
    DEPLOY_NETWORK: config.network,
    EXPECTED_DEPLOYER_ADDRESS: config.deployerAddress,
    EXPECTED_DEPLOYER_NONCE: config.expectedDeployerNonce === null ? "" : String(config.expectedDeployerNonce),
    GENESIS_CLAIM_RELEASE_CONTRACT: config.releaseContract,
    GENESIS_CLAIM_PRIMARY_SALE: config.primarySale,
    GENESIS_CLAIM_TOKEN_ID: config.tokenId.toString(),
    GENESIS_CLAIM_START: config.claimStart.toString(),
    GENESIS_CLAIM_WINDOW_SECONDS: config.claimWindow.toString(),
    GENESIS_PUBLIC_WINDOW_SECONDS: config.publicWindow.toString(),
    GENESIS_PUBLIC_PRICE_WEI: config.publicPriceWei.toString(),
    GENESIS_CLAIM_ALLOCATION: config.allocation.toString(),
    GENESIS_PUBLIC_MINT_ALLOCATION: config.publicAllocation.toString(),
    GENESIS_EXPECT_OPEN_EDITION: config.expectOpenEdition ? "yes" : "no",
    GENESIS_CLAIM_ADMIN: config.admin,
    GENESIS_CLAIM_SIGNER_ADDRESS: config.signer,
  };
}

/**
 * Signing additions to a dry-run plan (mainnet, and the Fuji Rabby test path): the exact unsigned creation transaction for the owner to sign
 * in Rabby, and the ISSUER_ROLE grant prepared for the account that actually holds the authority to
 * make it (DEFAULT_ADMIN_ROLE on the release, which createRelease gives the calling artist). Refuses a
 * release the artist wallet does not administer, or one the deployer or fee recipient administers.
 */
export async function claimSigningPlan(config, facts, plan, { provider, artifact }) {
  const [releaseOwner] = await read(provider, RELEASE, config.releaseContract, "owner");
  const owner = getAddress(releaseOwner);
  const isAdmin = async (account) => (await read(provider, RELEASE, config.releaseContract, "hasRole", [ZeroHash, account]))[0];
  if (owner !== getAddress(MAINNET_ARTIST_WALLET)) throw new DeploymentError(`The release ${config.releaseContract} is owned by ${owner}, not the artist wallet ${MAINNET_ARTIST_WALLET}. Releases are created by the artist, never the deployer.`);
  if (!(await isAdmin(owner))) throw new DeploymentError(`The release owner ${owner} does not hold DEFAULT_ADMIN_ROLE, so it cannot grant ISSUER_ROLE.`);
  if (await isAdmin(MAINNET_DEPLOYER)) throw new DeploymentError("The deployer holds DEFAULT_ADMIN_ROLE on the release; the deployer must hold no release authority.");
  if (await isAdmin(MAINNET_FEE_RECIPIENT)) throw new DeploymentError("The passive fee recipient holds DEFAULT_ADMIN_ROLE on the release; it must hold no role.");
  const data = `${artifact.bytecode.object}${AbiCoder.defaultAbiCoder().encode(CONSTRUCTOR_TYPES, facts.args).slice(2)}`;
  const estimatedGas = await provider.estimateGas({ from: config.deployerAddress, data });
  let request;
  try {
    request = creationRequest({ step: 1, contract: "GenesisHolderClaim", chainId: config.chainId, from: config.deployerAddress, nonce: facts.deployerNonce, data, estimatedGas, predictedAddress: facts.predictedClaim });
  } catch (error) {
    if (error instanceof SigningRequestError) throw new DeploymentError(error.message);
    throw error;
  }
  return {
    ...plan,
    readyToSign: facts.pendingNonce === facts.deployerNonce && (config.expectedDeployerNonce === null || config.expectedDeployerNonce === facts.deployerNonce),
    signingRequests: [request],
    planInputs: claimPlanInputs(config),
    followUps: {
      ...plan.followUps,
      issuerGrant: {
        ...plan.followUps.issuerGrant,
        from: owner,
        authority: "DEFAULT_ADMIN_ROLE on the release, verified on chain",
        note: "A separate artist operation after the claim is verified: the artist wallet signs this grant in its own wallet session before claimStart. Never the deployer and never either Ledger.",
      },
    },
  };
}

export const mainnetSigningPlan = claimSigningPlan;

/** Verifies the owner-signed claim deployment from chain against the reviewed plan. */
export async function verifyClaimDeployment(provider, plan, hash, { timeoutMs } = {}) {
  const request = plan.signingRequests?.[0];
  if (!request) throw new DeploymentError("The plan has no signing request.");
  let mined;
  try {
    mined = await verifyCreationTransaction(provider, request, hash, { timeoutMs });
  } catch (error) {
    if (error instanceof SigningRequestError) throw new DeploymentError(error.message);
    throw error;
  }
  const { problems, facts } = await checkClaimState(provider, plan, mined.address);
  if (problems.length) throw new DeploymentError(`The mined claim does not match the reviewed parameters: ${problems.map((item) => item.split(" is ")[0]).join(", ")}.`);
  const expected = facts.parameters;
  const issuerGranted = facts.issuerGrant === "GRANTED";
  return { ...mined, parameters: expected, issuerGrant: issuerGranted ? "GRANTED" : "PENDING (artist operation)" };
}

/** The committed claim record, built only from a verified deployment. */
export function buildClaimRecord(plan, verified, { sourceCommit = null, planDigest = null } = {}) {
  return {
    network: plan.network, chainId: plan.chainId,
    signedBy: { deployer: plan.deployer, method: "owner-signed in Rabby; no private key left the wallet" },
    plan: { sourceCommit, digest: planDigest },
    claim: { name: "GenesisHolderClaim", address: verified.address, deploymentTransaction: verified.transaction, deploymentBlock: verified.block, deployer: plan.deployer, sourceCommit },
    parameters: verified.parameters,
    eligibility: { source: plan.eligibility.source, ruleText: plan.eligibility.ruleText },
    issuerGrant: { status: verified.issuerGrant, ...plan.followUps.issuerGrant },
  };
}

export async function loadClaimArtifact() {
  const artifact = JSON.parse(await readFile(resolve(ROOT, CLAIM_ARTIFACT_PATH), "utf8"));
  const inputs = artifact.abi?.find((item) => item.type === "constructor")?.inputs || [];
  if (!artifact.bytecode?.object || artifact.bytecode.object === "0x" || inputs.length !== CONSTRUCTOR_TYPES.length) throw new DeploymentError(`${CLAIM_ARTIFACT_PATH} is missing or is not the scheduled GenesisHolderClaim; run forge build.`);
  return artifact;
}

/** Fuji only. Mainnet is signed by the owner in Rabby and verified with verifyClaimDeployment. */
export async function broadcastClaim(config, provider, facts, { artifact, log = (value) => console.log(JSON.stringify(value, (_k, v) => text(v))), wallet, writeRecord = writeRecordFile } = {}) {
  if (config.network !== "fuji") throw new DeploymentError("Only Fuji is broadcast from this script; mainnet is signed by the owner in Rabby.");
  wallet ??= new Wallet(config.deployerPrivateKey, provider);
  await assertRpcChainId(provider, config.chainId);
  const deployer = getAddress(await wallet.getAddress());
  if (deployer !== config.deployerAddress) throw new DeploymentError("The deployment signer does not match the validated DEPLOYER_PRIVATE_KEY address; nothing was broadcast.");
  if (facts.pendingNonce !== facts.deployerNonce) throw new DeploymentError(`The deployer has pending transactions (nonce ${facts.deployerNonce}, pending ${facts.pendingNonce}); nothing was broadcast.`);
  if (config.expectedDeployerNonce === null || facts.deployerNonce !== config.expectedDeployerNonce) throw new DeploymentError(`The deployer nonce is ${facts.deployerNonce}, not the reviewed ${config.expectedDeployerNonce ?? "(missing)"}: the predicted address is stale. Run a new dry run; nothing was broadcast.`);
  log({ step: "BROADCAST_PREFLIGHT_PASSED", deployerNonce: facts.deployerNonce, predictedClaimAddress: facts.predictedClaim });
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, wallet).deploy(...facts.args, { nonce: facts.deployerNonce });
  const receipt = await contract.deploymentTransaction().wait();
  const claimAddress = getAddress(await contract.getAddress());
  log({ step: "CLAIM_MINED", claimAddress, transaction: receipt.hash, block: receipt.blockNumber, from: receipt.from });
  if (claimAddress !== facts.predictedClaim) throw new DeploymentError(`GenesisHolderClaim was mined at ${claimAddress}, not the predicted ${facts.predictedClaim}.`);
  const onchain = {};
  for (const name of ["releaseContract", "primarySale", "tokenId", "allocation", "publicAllocation", "claimStart", "claimWindow", "publicWindow", "claimEnd", "publicSaleEnd", "publicPriceWei", "ELIGIBILITY_RULE", "admin", "signer"]) [onchain[name]] = await read(provider, CLAIM, claimAddress, name);
  const expected = { releaseContract: config.releaseContract, primarySale: config.primarySale, tokenId: config.tokenId, allocation: config.allocation, publicAllocation: config.publicAllocation, claimStart: config.claimStart, claimWindow: config.claimWindow, publicWindow: config.publicWindow, claimEnd: config.claimEnd, publicSaleEnd: config.publicSaleEnd, publicPriceWei: config.publicPriceWei, ELIGIBILITY_RULE: facts.eligibility.rule, admin: config.admin, signer: config.signer };
  const mismatched = Object.keys(expected).filter((name) => String(onchain[name]).toLowerCase() !== String(expected[name]).toLowerCase());
  if (mismatched.length) throw new DeploymentError(`The mined claim does not match the reviewed parameters: ${mismatched.join(", ")}.`);
  const recordPath = `deployments/genesis-claim-${config.network}-${claimAddress}.json`;
  const record = { network: config.network, chainId: config.chainId, claim: { name: "GenesisHolderClaim", address: claimAddress, deploymentTransaction: receipt.hash, deploymentBlock: receipt.blockNumber, deployer, sourceCommit: process.env.GITHUB_SHA || null }, parameters: expected, eligibility: { source: facts.eligibility.source, ruleText: facts.eligibility.text }, issuerGrantPending: true };
  log({ step: "RECORD", path: recordPath, record });
  try { await writeRecord(recordPath, record); } catch (error) { log({ step: "RECORD_WRITE_FAILED", path: recordPath, error: error.message }); }
  return record;
}

async function writeRecordFile(relativePath, record) {
  const recordPath = resolve(ROOT, relativePath);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, (_k, v) => text(v), 2)}\n`, { flag: "wx" });
}

export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const config = validateClaimDeploymentEnv(env);
  const provider = dependencies.provider || new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
  const genesisProvider = dependencies.genesisProvider || new JsonRpcProvider(config.genesisRpcUrl, GENESIS_CHAIN_ID, { staticNetwork: true });
  const artifact = dependencies.artifact || await loadClaimArtifact();
  const facts = await preflightClaimDeployment(config, { provider, genesisProvider, artifact });
  let plan = buildPlan(config, facts);
  if (config.network === "mainnet") plan = await mainnetSigningPlan(config, facts, plan, { provider, artifact });
  if (!config.broadcast) {
    console.log(JSON.stringify({ mode: "DRY_RUN", ...plan }, null, 2));
    // The workflow binds the approved broadcast to this exact plan (scripts/deployment-plan-binding.mjs).
    const planOutput = String(env.PLAN_OUTPUT_PATH ?? "").trim();
    if (planOutput) await writeFile(resolve(planOutput), `${JSON.stringify({ mode: "DRY_RUN", ...plan }, null, 2)}\n`);
    console.log("No transaction was broadcast.");
    return { mode: "DRY_RUN", plan };
  }
  if (argv.includes("--dry-run")) throw new DeploymentError("--dry-run cannot be combined with BROADCAST_DEPLOYMENT=yes.");
  const record = await (dependencies.broadcastClaim || broadcastClaim)(config, provider, facts, { artifact });
  console.log(JSON.stringify({ mode: "BROADCAST_COMPLETE", record, followUps: plan.followUps }, (_k, v) => text(v), 2));
  return { mode: "BROADCAST_COMPLETE", record };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(`Genesis claim deployment preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
