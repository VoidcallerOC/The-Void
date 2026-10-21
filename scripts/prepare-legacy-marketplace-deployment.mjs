#!/usr/bin/env node
// DRY RUN ONLY. Prepares and validates the deployment parameters of LegacyCollectionMarketplace. It reads no private key, signs
// nothing and broadcasts nothing; it prints what an authorized operator would review before a separately approved deployment.
//
//   OWNER_SAFE_ADDRESS=0x... node scripts/prepare-legacy-marketplace-deployment.mjs
//
// Exit codes: 0 plan prepared and the supplied owner passed every check; 1 a check failed; 3 BLOCKED (no owner Safe supplied).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, JsonRpcProvider, getAddress, isAddress, keccak256 } from "ethers";
import { LEGACY_COLLECTION_MARKETPLACE } from "../config/legacy-collection-marketplace.js";
import { RELEASE_PER_CONTRACT_MANIFESTS } from "../config/release-network.js";

export const ARTIFACT_PATH = resolve(fileURLToPath(new URL("..", import.meta.url)), "out/LegacyCollectionMarketplace.sol/LegacyCollectionMarketplace.json");
const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = new Interface(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])", "function VERSION() view returns (string)"]);
const MARKET = new Interface([
  "constructor(address owner_)",
  "function allowCollection(address tokenContract, uint16 maxRoyaltyBps, uint256 minTokenId, uint256 maxTokenId)",
]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Validates an owner address for the marketplace: the intended network, not the deployer or any other role already in the
 * system, and a contract that behaves like a Safe. This proves the address is well-formed and plausible; it cannot prove it
 * is *the* Safe the organisation intends. That identity must be confirmed out of band by an authorized operator.
 * `rpc` = { chainId(): Promise<bigint|number>, getCode(address), call(to, data) } so it can be tested without a network.
 */
export async function validateOwnerSafe({ address, rpc, manifest = LEGACY_COLLECTION_MARKETPLACE, extraForbidden = [] }) {
  const problems = [];
  const warnings = [];
  const info = {};
  if (!address || String(address).trim() === "") return { ok: false, blocked: true, problems: ["No owner Safe address was supplied (OWNER_SAFE_ADDRESS)."], warnings, info };
  if (!isAddress(String(address))) return { ok: false, blocked: false, problems: ["The supplied owner is not a valid EVM address."], warnings, info };
  const owner = getAddress(String(address));
  info.owner = owner;
  if (owner === ZERO) problems.push("The owner may not be the zero address.");
  const mainnet = RELEASE_PER_CONTRACT_MANIFESTS.mainnet;
  const forbidden = [
    [mainnet.marketplaceFeeRecipient, "the platform fee recipient"],
    [mainnet.deployerAddress, "the recorded deployer wallet"],
    [mainnet.factoryAddress, "the release factory"],
    [mainnet.marketplaceAddress, "the V4 marketplace"],
    ...manifest.collections.map((item) => [item.address, `the ${item.name} contract`]),
    ...extraForbidden.map((entry) => [entry, "an address supplied as forbidden"]),
  ];
  for (const [candidate, label] of forbidden) if (candidate && same(candidate, owner)) problems.push(`The owner may not be ${label}.`);
  let chain;
  try { chain = Number(await rpc.chainId()); } catch { problems.push("The RPC chain id could not be read."); }
  info.chainId = chain;
  if (chain !== undefined && chain !== Number(manifest.chainId)) problems.push(`The RPC is on chain ${chain}, not ${manifest.chainId} (Avalanche C-Chain).`);
  if (problems.length === 0 || chain === Number(manifest.chainId)) {
    let code = "0x";
    try { code = await rpc.getCode(owner); } catch { problems.push("The owner's code could not be read."); }
    if (!code || code === "0x") problems.push("The owner has no contract code on this chain: it is not a deployed Safe.");
    else {
      try {
        const [threshold] = SAFE.decodeFunctionResult("getThreshold", await rpc.call(owner, SAFE.encodeFunctionData("getThreshold")));
        const [owners] = SAFE.decodeFunctionResult("getOwners", await rpc.call(owner, SAFE.encodeFunctionData("getOwners")));
        info.threshold = Number(threshold);
        info.signers = owners.map((entry) => getAddress(entry));
        if (info.threshold < 1 || info.signers.length < info.threshold) problems.push("The Safe's threshold/owners are inconsistent.");
        if (info.threshold < 2) warnings.push("The Safe threshold is below 2: a single signer can pause or re-scope the marketplace.");
        if (info.signers.some((entry) => same(entry, mainnet.deployerAddress))) warnings.push("The recorded deployer wallet is one of the Safe's signers.");
      } catch { problems.push("The owner does not answer getThreshold()/getOwners(): it does not look like a Safe."); }
      try { info.version = SAFE.decodeFunctionResult("VERSION", await rpc.call(owner, SAFE.encodeFunctionData("VERSION")))[0]; } catch { warnings.push("The Safe version could not be read."); }
    }
  }
  return { ok: problems.length === 0, blocked: false, problems, warnings, info };
}

/** The exact, reviewable parameters of the deployment and of the first post-deploy transaction. Pure; no network. */
export function buildDeploymentPlan({ manifest = LEGACY_COLLECTION_MARKETPLACE, owner, artifact = null }) {
  const collection = manifest.collections[0];
  if (manifest.collections.length !== 1) throw new Error("The audit candidate allowlists exactly one collection.");
  // Genesis policy: no platform fee. The contract has no fee parameter; the manifest must agree.
  if (manifest.platformFeeBps !== 0) throw new Error("The legacy marketplace charges no platform fee; the manifest must record platformFeeBps 0.");
  const ownerArg = owner ? getAddress(owner) : null;
  const plan = {
    broadcast: false,
    chainId: manifest.chainId,
    network: manifest.networkName,
    contract: "contracts/LegacyCollectionMarketplace.sol",
    constructor: { owner: ownerArg },
    constructorArgsEncoded: ownerArg ? AbiCoder.defaultAbiCoder().encode(["address"], [ownerArg]) : null,
    economics: { platformFeeBps: 0, royalty: "the collection's own ERC-2981 royaltyInfo, paid in full", seller: "sale price minus the royalty" },
    postDeploy: [{
      from: "owner Safe",
      to: "the deployed marketplace",
      function: "allowCollection(address,uint16,uint256,uint256)",
      args: { tokenContract: getAddress(collection.address), maxRoyaltyBps: collection.maxRoyaltyBps, minTokenId: collection.minTokenId, maxTokenId: collection.maxTokenId },
      calldata: MARKET.encodeFunctionData("allowCollection", [getAddress(collection.address), collection.maxRoyaltyBps, collection.minTokenId, collection.maxTokenId]),
    }],
    manifestAfterVerification: { deployed: true, marketplaceAddress: "<deployed address>", deploymentBlock: "<deployment block>", ownerAddress: owner ? getAddress(owner) : "<owner Safe>" },
    build: null,
  };
  if (artifact?.deployedBytecode?.object && artifact?.bytecode?.object) {
    const metadata = artifact.metadata?.settings ?? {};
    plan.build = {
      solc: artifact.metadata?.compiler?.version ?? null,
      optimizer: metadata.optimizer ?? null,
      evmVersion: metadata.evmVersion ?? null,
      creationBytecodeKeccak256: keccak256(artifact.bytecode.object),
      runtimeBytecodeKeccak256: keccak256(artifact.deployedBytecode.object),
    };
  }
  return plan;
}

export function loadArtifact(path = ARTIFACT_PATH) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export async function main(env = process.env, log = console.log) {
  const rpcUrl = env.AVALANCHE_MAINNET_RPC_URL || RELEASE_PER_CONTRACT_MANIFESTS.mainnet.rpcUrl;
  const provider = new JsonRpcProvider(rpcUrl, Number(LEGACY_COLLECTION_MARKETPLACE.chainId), { staticNetwork: true });
  const rpc = {
    chainId: async () => (await provider.getNetwork()).chainId,
    getCode: (address) => provider.getCode(address),
    call: (to, data) => provider.call({ to, data }),
  };
  const result = await validateOwnerSafe({ address: env.OWNER_SAFE_ADDRESS, rpc });
  const plan = buildDeploymentPlan({ owner: result.ok ? result.info.owner : null, artifact: loadArtifact() });
  log(JSON.stringify({ ownerCheck: result, plan }, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  if (result.blocked) { log("\nBLOCKED: no owner Safe address supplied. Nothing was deployed or signed."); return 3; }
  if (!result.ok) { log("\nFAILED: the supplied owner did not pass validation. Nothing was deployed or signed."); return 1; }
  log("\nOWNER CHECKS PASSED (address validity only). An authorized operator must still confirm this is the intended Safe. Nothing was deployed or signed.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
