// Server side of GenesisWeekendClaim: the dual-chain (C-Chain + The Grotto) snapshot claim.
//
// Selected with GENESIS_CLAIM_MODE=weekend. There is no signer and no voucher: eligibility is the committed
// snapshot (deploy/mainnet/genesis-weekend/snapshot.json), whose Merkle root and hash the deployed contract
// stores immutably. /api/claims/config verifies the contract against the snapshot and the edition's supply
// accounting before publishing anything; /api/claims/eligibility returns a wallet's proof. Nothing is written
// to the database, and no historical claim record is touched.
import fs from "node:fs";
import { Contract, JsonRpcProvider, getAddress, isAddress } from "ethers";
import { ApiError } from "./api-errors.js";
import { buildWeekendTree } from "./genesis-weekend-merkle.js";
import { snapshotHashFor, WEEKEND_RULE } from "./genesis-weekend-snapshot.js";

export const WEEKEND_MODE = "weekend-merkle";
export const WEEKEND_CONFIG_CACHE_MS = 30_000;
// GenesisWeekendClaim.WEEKEND_CLAIM_END: 2026-11-02 04:59:59 UTC.
export const WEEKEND_CLAIM_END = 1_793_595_599n;
const GENESIS_CONTRACT = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";

const CLAIM_ABI = [
  "function releaseContract() view returns (address)",
  "function primarySale() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function merkleRoot() view returns (bytes32)",
  "function snapshotHash() view returns (bytes32)",
  "function eligibleWallets() view returns (uint256)",
  "function snapshotCChainBlock() view returns (uint256)",
  "function snapshotGrottoBlock() view returns (uint256)",
  "function claimEnd() view returns (uint256)",
  "function claimStart() view returns (uint256)",
  "function baselineClaimedSupply() view returns (uint256)",
  "function claimedSupply() view returns (uint256)",
  "function active() view returns (bool)",
  "function paused() view returns (bool)",
  "function publicSaleStart() view returns (uint256)",
  "function publicSaleEnd() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)",
  "function GENESIS_CONTRACT() view returns (address)",
  "function priorClaimOne() view returns (address)",
  "function priorClaimTwo() view returns (address)",
  "function priorClaimThree() view returns (address)",
  "function hasClaimedAnywhere(address) view returns (bool)",
];
const RELEASE_ABI = [
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];
const SALE_ABI = ["function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)"];

export function weekendModeEnabled(env) {
  return String(env.GENESIS_CLAIM_MODE || "").toLowerCase() === "weekend";
}

function configuredAddress(value, name) {
  if (!isAddress(String(value || ""))) throw new Error(`${name} must be an address.`);
  return getAddress(value);
}

/** Loads the committed snapshot and refuses one whose root or hash cannot be recomputed from its own list. */
export function loadWeekendSnapshot(text) {
  const snapshot = JSON.parse(text);
  if (snapshot.ok !== true || !Array.isArray(snapshot.eligible) || !snapshot.eligible.length) throw new Error("The weekend snapshot is not a passing snapshot.");
  if (snapshot.eligibilityRule !== WEEKEND_RULE) throw new Error("The weekend snapshot uses a different eligibility rule.");
  const tree = buildWeekendTree(snapshot.eligible.map(({ wallet }) => wallet));
  if (tree.size !== snapshot.eligible.length || tree.size !== Number(snapshot.eligibleWallets)) throw new Error("The weekend snapshot lists a wallet twice or miscounts its wallets.");
  if (tree.root !== snapshot.merkleRoot) throw new Error("The weekend snapshot root does not match its wallet list.");
  const hash = snapshotHashFor({ cchainBlock: snapshot.cchain.block, cchainBlockHash: snapshot.cchain.blockHash, grottoBlock: snapshot.grotto.block, grottoBlockHash: snapshot.grotto.blockHash, root: tree.root, wallets: tree.wallets });
  if (hash !== snapshot.snapshotHash) throw new Error("The weekend snapshot hash does not match its contents.");
  const entries = new Map(snapshot.eligible.map((entry) => [getAddress(entry.wallet), entry]));
  return Object.freeze({ snapshot, tree, entries });
}

export function loadGenesisWeekendClaimConfig(env, { readFile = (path) => fs.readFileSync(path, "utf8") } = {}) {
  if (!weekendModeEnabled(env)) return null;
  const path = env.GENESIS_WEEKEND_SNAPSHOT || "deploy/mainnet/genesis-weekend/snapshot.json";
  const loaded = loadWeekendSnapshot(readFile(path));
  return Object.freeze({
    destinationChainId: 43114,
    destinationRpcUrl: String(env.GENESIS_DESTINATION_RPC_URL || "https://api.avax.network/ext/bc/C/rpc"),
    claimContract: configuredAddress(env.GENESIS_WEEKEND_CLAIM_CONTRACT, "GENESIS_WEEKEND_CLAIM_CONTRACT"),
    // The same release, sale and token variables the existing claim configuration already sets.
    releaseContract: configuredAddress(env.GENESIS_CLAIM_RELEASE_CONTRACT, "GENESIS_CLAIM_RELEASE_CONTRACT"),
    primarySale: configuredAddress(env.GENESIS_CLAIM_PRIMARY_SALE, "GENESIS_CLAIM_PRIMARY_SALE"),
    tokenId: BigInt(env.GENESIS_CLAIM_TOKEN_ID || "1"),
    priorClaims: Object.freeze(loaded.snapshot.priorClaims.map((address) => getAddress(address))),
    historicalClaimedSupply: BigInt(loaded.snapshot.historicalClaimedSupply),
    ...loaded,
  });
}

/**
 * Weekend mode is configured but its snapshot or settings cannot be loaded. Every claim route fails closed
 * with 503 CLAIM_CONFIG_UNAVAILABLE (never CLAIM_UNAVAILABLE), so Artist Studio keeps blocking sale edits
 * instead of treating the claim as absent.
 */
export function createUnavailableWeekendClaimService(reason) {
  const unavailable = () => { throw new ApiError(503, "CLAIM_CONFIG_UNAVAILABLE", "The Genesis weekend claim is configured but could not be loaded."); };
  return Object.freeze({
    mode: WEEKEND_MODE,
    unavailableReason: String(reason || ""),
    config: null,
    verifyConfigBindings: async () => unavailable(),
    verifyContractBindings: async () => unavailable(),
    checkEligibility: async () => unavailable(),
    issueVoucher: unavailable,
    issueEarlyAccessVoucher: unavailable,
  });
}

export function createGenesisWeekendClaimService({ config, provider = null, clock = () => Math.floor(Date.now() / 1000), monotonicNow = () => performance.now(), logger = console } = {}) {
  if (!config) return null;
  const rpc = provider || new JsonRpcProvider(config.destinationRpcUrl, config.destinationChainId, { staticNetwork: true });
  const claim = new Contract(config.claimContract, CLAIM_ABI, rpc);
  const release = new Contract(config.releaseContract, RELEASE_ABI, rpc);
  const sale = new Contract(config.primarySale, SALE_ABI, rpc);
  const { snapshot } = config;

  const baseConfig = Object.freeze({
    enabled: true,
    mode: WEEKEND_MODE,
    genesisContract: GENESIS_CONTRACT,
    genesisChainIds: [43114, 36463],
    tokenIds: ["0", "1", "2", "3"],
    eligibilityRule: WEEKEND_RULE,
    eligibility: "snapshot",
    snapshotCChainBlock: String(snapshot.cchain.block),
    snapshotGrottoBlock: String(snapshot.grotto.block),
    eligibleWallets: String(snapshot.eligibleWallets),
    merkleRoot: snapshot.merkleRoot,
    destinationChainId: config.destinationChainId,
    releaseContract: config.releaseContract,
    primarySale: config.primarySale,
    claimContract: config.claimContract,
    tokenId: config.tokenId.toString(),
    allocation: "0",
    publicAllocation: "0",
  });

  async function readBindings() {
    const network = await rpc.getNetwork();
    const [claimRelease, claimSale, claimToken, root, hash, eligibleWallets, cBlock, gBlock, claimEnd, claimStart, baseline, claimedSupply, active, paused,
      publicSaleStart, publicPriceWei, rule, genesis, priorOne, priorTwo, priorThree] = await Promise.all([
      claim.releaseContract(), claim.primarySale(), claim.tokenId(), claim.merkleRoot(), claim.snapshotHash(), claim.eligibleWallets(), claim.snapshotCChainBlock(),
      claim.snapshotGrottoBlock(), claim.claimEnd(), claim.claimStart(), claim.baselineClaimedSupply(), claim.claimedSupply(), claim.active(), claim.paused(),
      claim.publicSaleStart(), claim.publicPriceWei(), claim.ELIGIBILITY_RULE(), claim.GENESIS_CONTRACT(),
      claim.priorClaimOne(), claim.priorClaimTwo(), claim.priorClaimThree(),
    ]);
    const [edition, saleData, issuerRole] = await Promise.all([release.edition(config.tokenId), sale.sales(config.tokenId), release.ISSUER_ROLE()]);
    const claimIsIssuer = await release.hasRole(issuerRole, config.claimContract);
    const claimsOpen = BigInt(clock()) < BigInt(claimEnd);
    const sold = BigInt(saleData.sold ?? saleData[2]);
    const minted = BigInt(edition.mintedSupply ?? edition[4]);
    const mismatch = Number(network.chainId) !== config.destinationChainId
      || getAddress(claimRelease) !== config.releaseContract || getAddress(claimSale) !== config.primarySale || BigInt(claimToken) !== config.tokenId
      || root !== snapshot.merkleRoot || hash !== snapshot.snapshotHash || BigInt(eligibleWallets) !== BigInt(snapshot.eligibleWallets)
      || BigInt(cBlock) !== BigInt(snapshot.cchain.block) || BigInt(gBlock) !== BigInt(snapshot.grotto.block)
      || rule !== WEEKEND_RULE || getAddress(genesis) !== GENESIS_CONTRACT
      || [priorOne, priorTwo, priorThree].some((address, i) => getAddress(address) !== config.priorClaims[i])
      || BigInt(baseline) !== config.historicalClaimedSupply
      || BigInt(claimEnd) !== WEEKEND_CLAIM_END
      // The production supply invariant: every minted copy is a paid sale or a counted Genesis claim.
      || minted !== sold + BigInt(claimedSupply)
      || !(saleData.configured ?? saleData[7])
      // While claims can still be made the contract must be able to mint; after claimEnd its role may be revoked.
      || (claimsOpen && !claimIsIssuer);
    if (mismatch) throw new ApiError(503, "CLAIM_BINDING_MISMATCH", "The configured claim contract, release, supply, or chain does not match the authorized target.");
    const publicConfig = Object.freeze({
      ...baseConfig,
      claimStart: BigInt(claimStart).toString(),
      claimEnd: BigInt(claimEnd).toString(),
      active: Boolean(active),
      paused: Boolean(paused),
      claimedSupply: BigInt(claimedSupply).toString(),
      publicSaleStart: BigInt(publicSaleStart).toString(),
      publicSaleEnd: BigInt(saleData.endTime ?? saleData[5]).toString(),
      publicPriceWei: BigInt(publicPriceWei).toString(),
    });
    return { saleEndTime: BigInt(saleData.endTime ?? saleData[5]), publicConfig, claimEnd: BigInt(claimEnd) };
  }

  let cached = null;
  let cachedAt = -Infinity;
  let inflight = null;
  async function verifyConfigBindings() {
    if (cached && monotonicNow() - cachedAt < WEEKEND_CONFIG_CACHE_MS) return cached;
    if (!inflight) {
      inflight = readBindings()
        .then((verified) => { cached = verified; cachedAt = monotonicNow(); return verified; })
        .catch((error) => {
          if (error instanceof ApiError) throw error;
          logger?.warn?.("genesis.weekend.config_unavailable", { error: String(error?.code || "RPC_ERROR") });
          throw new ApiError(503, "CLAIM_CONFIG_UNAVAILABLE", "The claim configuration could not be verified right now. Try again shortly.");
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function checkEligibility(walletInput) {
    if (!isAddress(String(walletInput || ""))) throw new ApiError(400, "INVALID_WALLET", "A valid wallet address is required.");
    const wallet = getAddress(walletInput);
    // The close is fixed in the contract, so a closed window answers before any chain read can fail.
    if (BigInt(clock()) >= WEEKEND_CLAIM_END) throw new ApiError(409, "CLAIM_WINDOW_CLOSED", "The Genesis claim window has closed.");
    const verified = await verifyConfigBindings();
    let claimed;
    try {
      claimed = await claim.hasClaimedAnywhere(wallet);
    } catch {
      throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Claim status could not be read from Avalanche C-Chain.");
    }
    if (claimed) return Object.freeze({ eligible: false, reason: "ALREADY_CLAIMED", wallet });
    const entry = config.entries.get(wallet);
    if (!entry) return Object.freeze({ eligible: false, reason: "NOT_IN_SNAPSHOT", wallet });
    return Object.freeze({
      eligible: true,
      wallet,
      sources: entry.sources,
      proof: config.tree.proof(wallet),
      claimContract: config.claimContract,
      active: verified.publicConfig.active,
      paused: verified.publicConfig.paused,
    });
  }

  function closed() {
    throw new ApiError(409, "CLAIM_WINDOW_CLOSED", "Signed claim vouchers are no longer issued. The Genesis weekend claim uses its snapshot allowlist.");
  }

  return Object.freeze({
    mode: WEEKEND_MODE,
    config: baseConfig,
    verifyConfigBindings,
    verifyContractBindings: verifyConfigBindings,
    checkEligibility,
    issueVoucher: closed,
    issueEarlyAccessVoucher: closed,
  });
}
