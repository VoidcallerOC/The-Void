import process from "node:process";
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress, hexlify, id, isAddress, randomBytes } from "ethers";
import { ApiError } from "./api-errors.js";
import { productionChainId } from "./config.js";

export const GENESIS_CONTRACT = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
export const GENESIS_CHAIN_ID = 43114;
export const GENESIS_TOKEN_IDS = Object.freeze([0n, 1n, 2n, 3n]);
export const LEGACY_FUJI_SINGLETON = "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6";
// Production schedule. C-Chain (43114) must use exactly these and the production price; only Fuji
// may configure shorter test windows (never below one minute), as the claim contract also enforces.
export const CLAIM_WINDOW_SECONDS = 86_400n;
export const PUBLIC_WINDOW_SECONDS = 7n * 86_400n;
export const MINIMUM_TEST_WINDOW_SECONDS = 60n;
export const MAINNET_PUBLIC_PRICE_WEI = 250_000_000_000_000_000n; // 0.25 AVAX

/**
 * Validates the schedule and price for the destination chain. Mainnet always gets the production
 * 24 hours / 7 days at 0.25 AVAX; anything else fails closed. Fuji windows default to production.
 */
export function claimSchedule({ destinationChainId, claimWindow = CLAIM_WINDOW_SECONDS, publicWindow = PUBLIC_WINDOW_SECONDS, publicPriceWei }) {
  if (destinationChainId === GENESIS_CHAIN_ID) {
    if (claimWindow !== CLAIM_WINDOW_SECONDS || publicWindow !== PUBLIC_WINDOW_SECONDS) throw new GenesisClaimConfigurationError("Mainnet requires a 24-hour Genesis claim window and a 7-day public window.");
    if (publicPriceWei !== MAINNET_PUBLIC_PRICE_WEI) throw new GenesisClaimConfigurationError("Mainnet requires a public price of exactly 0.25 AVAX (250000000000000000 wei).");
  } else if (claimWindow < MINIMUM_TEST_WINDOW_SECONDS || publicWindow < MINIMUM_TEST_WINDOW_SECONDS) {
    throw new GenesisClaimConfigurationError("Claim and public windows must each be at least 60 seconds.");
  }
  return Object.freeze({ claimWindow, publicWindow });
}

/**
 * Eligibility is fixed at one C-Chain block: a wallet qualifies only if it held token 0, 1, 2 or 3
 * at that block. Transfers after the snapshot neither add nor remove eligibility. The rule text
 * names the block and its hash, and the claim contract stores the rule's hash, so every voucher
 * is bound to this exact snapshot. Anyone can recompute it with balanceOf(wallet, id) at the block.
 */
export function genesisEligibilityRule({ snapshotBlock, snapshotBlockHash }) {
  const text = `the-void:genesis-eligibility:v2:chain=${GENESIS_CHAIN_ID}:contract=${GENESIS_CONTRACT.toLowerCase()}:block=${BigInt(snapshotBlock)}:hash=${String(snapshotBlockHash).toLowerCase()}:balanceOf(wallet,0)>0|balanceOf(wallet,1)>0|balanceOf(wallet,2)>0|balanceOf(wallet,3)>0`;
  return Object.freeze({ text, rule: id(text) });
}

const GENESIS_INTERFACE = new Interface(["function balanceOf(address account,uint256 id) view returns (uint256)"]);
const CLAIM_ABI = [
  "function hasClaimed(address) view returns (bool)",
  "function claimedSupply() view returns (uint256)",
  "function allocation() view returns (uint256)",
  "function publicAllocation() view returns (uint256)",
  "function releaseContract() view returns (address)",
  "function primarySale() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function signer() view returns (address)",
  "function destinationChainId() view returns (uint256)",
  "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)",
  "function claimWindow() view returns (uint256)",
  "function publicWindow() view returns (uint256)",
  "function publicSaleEnd() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)",
  "function GENESIS_CONTRACT() view returns (address)",
  "function GENESIS_CHAIN_ID() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)",
];
const RELEASE_ABI = [
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
];
const SALE_ABI = ["function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)"];
const VOUCHER_TYPES = Object.freeze({
  ClaimVoucher: [
    { name: "claimant", type: "address" },
    { name: "genesisContract", type: "address" },
    { name: "genesisChainId", type: "uint256" },
    { name: "eligibilityRule", type: "bytes32" },
    { name: "destinationChainId", type: "uint256" },
    { name: "releaseContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "quantity", type: "uint256" },
    { name: "allocation", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
});

export class GenesisClaimConfigurationError extends Error {
  constructor(message) { super(message); this.name = "GenesisClaimConfigurationError"; }
}

function configuredAddress(value, name) {
  const raw = String(value || "").trim();
  if (!isAddress(raw) || getAddress(raw) === "0x0000000000000000000000000000000000000000") {
    throw new GenesisClaimConfigurationError(`${name} must be a non-zero EVM address.`);
  }
  return getAddress(raw);
}

function positiveBigInt(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be a positive integer.`);
  }
}

function nonNegativeBigInt(value, name) {
  try {
    const text = String(value ?? "").trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error();
    return BigInt(text);
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be a non-negative integer.`);
  }
}

function httpUrl(value, name) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be an absolute HTTP(S) URL without credentials or a fragment.`);
  }
}

function blockHash(value, name) {
  const text = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new GenesisClaimConfigurationError(`${name} must be a 32-byte block hash.`);
  return text.toLowerCase();
}

export function loadGenesisClaimConfig(env = process.env) {
  if (String(env.GENESIS_CLAIM_ENABLED || "").toLowerCase() !== "true") return null;
  const destinationChainId = productionChainId(env);
  const releaseContract = configuredAddress(env.GENESIS_CLAIM_RELEASE_CONTRACT, "GENESIS_CLAIM_RELEASE_CONTRACT");
  const primarySale = configuredAddress(env.GENESIS_CLAIM_PRIMARY_SALE, "GENESIS_CLAIM_PRIMARY_SALE");
  const claimContract = configuredAddress(env.GENESIS_CLAIM_CONTRACT, "GENESIS_CLAIM_CONTRACT");
  if (releaseContract.toLowerCase() === LEGACY_FUJI_SINGLETON.toLowerCase()) {
    throw new GenesisClaimConfigurationError("The legacy Fuji V2 singleton may not be the claim release target.");
  }
  if (releaseContract.toLowerCase() === claimContract.toLowerCase() || primarySale.toLowerCase() === releaseContract.toLowerCase()) {
    throw new GenesisClaimConfigurationError("The release, primary sale, and claim contract must be distinct addresses.");
  }
  const tokenIdValue = String(env.GENESIS_CLAIM_TOKEN_ID ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(tokenIdValue)) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_TOKEN_ID must be a non-negative integer.");
  const tokenId = BigInt(tokenIdValue);
  // 0 means uncapped: an open edition has no reserved claim allocation and no public sale cap.
  const allocation = nonNegativeBigInt(env.GENESIS_CLAIM_ALLOCATION, "GENESIS_CLAIM_ALLOCATION");
  const publicAllocation = nonNegativeBigInt(env.GENESIS_PUBLIC_MINT_ALLOCATION, "GENESIS_PUBLIC_MINT_ALLOCATION");
  const claimStart = positiveBigInt(env.GENESIS_CLAIM_START, "GENESIS_CLAIM_START");
  const publicPriceWei = positiveBigInt(env.GENESIS_PUBLIC_PRICE_WEI, "GENESIS_PUBLIC_PRICE_WEI");
  const snapshotBlock = positiveBigInt(env.GENESIS_SNAPSHOT_BLOCK, "GENESIS_SNAPSHOT_BLOCK");
  const snapshotBlockHash = blockHash(env.GENESIS_SNAPSHOT_BLOCK_HASH, "GENESIS_SNAPSHOT_BLOCK_HASH");
  const { claimWindow, publicWindow } = claimSchedule({
    destinationChainId,
    claimWindow: env.GENESIS_CLAIM_WINDOW_SECONDS === undefined || env.GENESIS_CLAIM_WINDOW_SECONDS === "" ? CLAIM_WINDOW_SECONDS : positiveBigInt(env.GENESIS_CLAIM_WINDOW_SECONDS, "GENESIS_CLAIM_WINDOW_SECONDS"),
    publicWindow: env.GENESIS_PUBLIC_WINDOW_SECONDS === undefined || env.GENESIS_PUBLIC_WINDOW_SECONDS === "" ? PUBLIC_WINDOW_SECONDS : positiveBigInt(env.GENESIS_PUBLIC_WINDOW_SECONDS, "GENESIS_PUBLIC_WINDOW_SECONDS"),
    publicPriceWei,
  });
  const privateKey = String(env.GENESIS_CLAIM_SIGNER_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_SIGNER_PRIVATE_KEY must be a server-side 32-byte hex secret.");
  return Object.freeze({
    destinationChainId,
    genesisRpcUrl: httpUrl(env.GENESIS_RPC_URL, "GENESIS_RPC_URL"),
    destinationRpcUrl: httpUrl(env.GENESIS_DESTINATION_RPC_URL, "GENESIS_DESTINATION_RPC_URL"),
    releaseContract,
    primarySale,
    claimContract,
    tokenId,
    allocation,
    publicAllocation,
    claimStart,
    claimWindow,
    publicWindow,
    claimEnd: claimStart + claimWindow,
    publicSaleEnd: claimStart + claimWindow + publicWindow - 1n,
    publicPriceWei,
    snapshotBlock,
    snapshotBlockHash,
    eligibilityRule: genesisEligibilityRule({ snapshotBlock, snapshotBlockHash }).rule,
    privateKey,
  });
}

function toPublicConfig(config) {
  if (!config) return null;
  return Object.freeze({
    enabled: true,
    genesisContract: GENESIS_CONTRACT,
    genesisChainId: GENESIS_CHAIN_ID,
    tokenIds: GENESIS_TOKEN_IDS.map(String),
    eligibilityRule: config.eligibilityRule,
    snapshotBlock: config.snapshotBlock.toString(),
    snapshotBlockHash: config.snapshotBlockHash,
    destinationChainId: config.destinationChainId,
    releaseContract: config.releaseContract,
    primarySale: config.primarySale,
    claimContract: config.claimContract,
    tokenId: config.tokenId.toString(),
    allocation: config.allocation.toString(),
    publicAllocation: config.publicAllocation.toString(),
    claimStart: config.claimStart.toString(),
    claimEnd: config.claimEnd.toString(),
    claimWindow: config.claimWindow.toString(),
    publicWindow: config.publicWindow.toString(),
    publicSaleEnd: config.publicSaleEnd.toString(),
    publicPriceWei: config.publicPriceWei.toString(),
  });
}

export function createGenesisClaimService({
  config = loadGenesisClaimConfig(),
  genesisProvider = null,
  destinationProvider = null,
  signer = null,
  eligibilityReader = null,
  bindingReader = null,
  claimStateReader = null,
  clock = () => Math.floor(Date.now() / 1000),
  // 256 random bits. ethers' randomBytes returns a Uint8Array, so it must be hex-encoded explicitly.
  nonce = () => BigInt(hexlify(randomBytes(32))),
} = {}) {
  if (!config) return null;
  const sourceProvider = genesisProvider || new JsonRpcProvider(config.genesisRpcUrl);
  const targetProvider = destinationProvider || new JsonRpcProvider(config.destinationRpcUrl);
  const claimSigner = signer || new Wallet(config.privateKey);
  const claim = new Contract(config.claimContract, CLAIM_ABI, targetProvider);
  const release = new Contract(config.releaseContract, RELEASE_ABI, targetProvider);
  const sale = new Contract(config.primarySale, SALE_ABI, targetProvider);

  async function verifyContractBindings() {
    const [network, claimRelease, claimSale, claimToken, claimAllocation, claimPublicAllocation, claimChain, claimStartAt, claimEndAt,
      claimWindowAt, publicWindowAt, claimPublicEnd, claimPrice, claimGenesis, claimGenesisChain, claimRule, claimSignerAddress, claimedSupply, maxSupply, editionData, saleData] = await Promise.all([
      targetProvider.getNetwork(), claim.releaseContract(), claim.primarySale(), claim.tokenId(), claim.allocation(),
      claim.publicAllocation(), claim.destinationChainId(), claim.claimStart(), claim.claimEnd(), claim.claimWindow(), claim.publicWindow(),
      claim.publicSaleEnd(), claim.publicPriceWei(),
      claim.GENESIS_CONTRACT(), claim.GENESIS_CHAIN_ID(), claim.ELIGIBILITY_RULE(), claim.signer(), claim.claimedSupply(),
      release.maxSupplyOf(config.tokenId), release.edition(config.tokenId), sale.sales(config.tokenId),
    ]);
    // The claim mints through the release's issuer path; without the grant every claim would revert.
    const claimIsIssuer = await release.hasRole(await release.ISSUER_ROLE(), config.claimContract);
    const total = config.allocation + config.publicAllocation;
    // An open edition (maxSupply 0) has no cap to compare against.
    const editionCapTooSmall = BigInt(maxSupply) !== 0n && (config.allocation === 0n || BigInt(maxSupply) < total);
    if (Number(network.chainId) !== config.destinationChainId
      || getAddress(claimRelease) !== config.releaseContract
      || getAddress(claimSale) !== config.primarySale
      || BigInt(claimToken) !== config.tokenId
      || BigInt(claimAllocation) !== config.allocation
      || BigInt(claimPublicAllocation) !== config.publicAllocation
      || BigInt(claimChain) !== BigInt(config.destinationChainId)
      || BigInt(claimStartAt) !== config.claimStart
      || BigInt(claimEndAt) !== config.claimEnd
      || BigInt(claimWindowAt) !== config.claimWindow
      || BigInt(publicWindowAt) !== config.publicWindow
      || BigInt(claimPublicEnd) !== config.publicSaleEnd
      || BigInt(claimPrice) !== config.publicPriceWei
      || getAddress(claimGenesis) !== GENESIS_CONTRACT
      || BigInt(claimGenesisChain) !== BigInt(GENESIS_CHAIN_ID)
      || String(claimRule).toLowerCase() !== config.eligibilityRule.toLowerCase()
      || getAddress(claimSignerAddress) !== getAddress(claimSigner.address)
      || editionCapTooSmall
      || !claimIsIssuer
      || BigInt(editionData.mintedSupply ?? editionData[0]?.mintedSupply ?? editionData[0]?.[4] ?? editionData[4]) !== BigInt(saleData.sold ?? saleData[2]) + BigInt(claimedSupply)
      || BigInt(saleData.priceWei ?? saleData[0]) !== config.publicPriceWei
      || BigInt(saleData.maxSupply ?? saleData[1]) !== config.publicAllocation
      || BigInt(saleData.startTime ?? saleData[4]) !== config.claimEnd
      || BigInt(saleData.endTime ?? saleData[5]) !== config.publicSaleEnd
      || !(saleData.configured ?? saleData[7])) {
      throw new ApiError(503, "CLAIM_BINDING_MISMATCH", "The configured claim contract, release, supply, or chain does not match the authorized target.");
    }
  }

  // The snapshot must be the exact C-Chain block the contract's rule commits to. A provider on another
  // chain, or one that reports a different hash for that height, fails closed.
  let snapshotVerified = false;
  async function assertSnapshotBlock() {
    if (snapshotVerified) return;
    const network = await sourceProvider.getNetwork();
    if (Number(network.chainId) !== GENESIS_CHAIN_ID) throw new Error("Genesis RPC is not Avalanche C-Chain (43114).");
    const block = await sourceProvider.getBlock(Number(config.snapshotBlock));
    if (!block?.hash || String(block.hash).toLowerCase() !== config.snapshotBlockHash) throw new Error("Genesis snapshot block hash does not match.");
    snapshotVerified = true;
  }

  async function checkEligibility(wallet) {
    if (!isAddress(wallet) || getAddress(wallet) === "0x0000000000000000000000000000000000000000") {
      throw new ApiError(400, "INVALID_WALLET", "A non-zero claimant wallet address is required.");
    }
    try {
      let eligibleTokenIds;
      if (eligibilityReader) {
        eligibleTokenIds = await eligibilityReader(getAddress(wallet));
        if (!Array.isArray(eligibleTokenIds) || eligibleTokenIds.some((value) => !GENESIS_TOKEN_IDS.some((idValue) => idValue.toString() === String(value)))) {
          throw new Error("Eligibility reader returned an invalid Genesis token set.");
        }
      } else {
        await assertSnapshotBlock();
        const blockTag = Number(config.snapshotBlock);
        const balances = await Promise.all(GENESIS_TOKEN_IDS.map(async (tokenId) => {
          const data = GENESIS_INTERFACE.encodeFunctionData("balanceOf", [getAddress(wallet), tokenId]);
          return GENESIS_INTERFACE.decodeFunctionResult("balanceOf", await sourceProvider.call({ to: GENESIS_CONTRACT, data, blockTag }))[0];
        }));
        eligibleTokenIds = balances.flatMap((balance, index) => BigInt(balance) > 0n ? [GENESIS_TOKEN_IDS[index].toString()] : []);
      }
      return Object.freeze({ eligible: eligibleTokenIds.length > 0, eligibleTokenIds });
    } catch {
      throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Genesis ownership could not be verified on Avalanche C-Chain.");
    }
  }

  async function issueVoucher(wallet) {
    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) throw new ApiError(403, "ACCESS_DENIED", "This wallet did not hold Genesis token 0, 1, 2, or 3 at the snapshot block.");
    const now = BigInt(clock());
    if (now < config.claimStart) throw new ApiError(409, "CLAIM_NOT_OPEN", "The Genesis claim window has not opened yet.");
    if (now >= config.claimEnd) throw new ApiError(409, "CLAIM_WINDOW_CLOSED", "The Genesis claim window has closed.");
    try {
      if (bindingReader) await bindingReader();
      else await verifyContractBindings();
      const { alreadyClaimed, claimedSupply } = claimStateReader
        ? await claimStateReader(getAddress(wallet))
        : await Promise.all([claim.hasClaimed(getAddress(wallet)), claim.claimedSupply()]).then(([alreadyClaimed, claimedSupply]) => ({ alreadyClaimed, claimedSupply }));
      if (alreadyClaimed) throw new ApiError(409, "ALREADY_CLAIMED", "This wallet has already claimed its Genesis allocation.");
      if (config.allocation !== 0n && BigInt(claimedSupply) >= config.allocation) throw new ApiError(409, "CLAIM_ALLOCATION_EXHAUSTED", "The reserved Genesis claim allocation has been exhausted.");
      const voucher = Object.freeze({
        claimant: getAddress(wallet),
        genesisContract: GENESIS_CONTRACT,
        genesisChainId: GENESIS_CHAIN_ID,
        eligibilityRule: config.eligibilityRule,
        destinationChainId: config.destinationChainId,
        releaseContract: config.releaseContract,
        tokenId: config.tokenId.toString(),
        quantity: "1",
        allocation: config.allocation.toString(),
        nonce: nonce().toString(),
        // Short-lived, and never past the claim window.
        deadline: String(BigInt(Math.min(clock() + 300, Number(config.claimEnd) - 1))),
      });
      const domain = {
        name: "The Void Genesis Holder Claim",
        version: "1",
        chainId: config.destinationChainId,
        verifyingContract: config.claimContract,
      };
      const signature = await claimSigner.signTypedData(domain, VOUCHER_TYPES, voucher);
      return Object.freeze({ voucher, signature, target: toPublicConfig(config) });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "CLAIM_AUTHORIZATION_UNAVAILABLE", "Claim authorization could not be issued for the configured destination.");
    }
  }

  return Object.freeze({
    config: toPublicConfig(config),
    checkEligibility,
    issueVoucher,
    verifyContractBindings,
  });
}
