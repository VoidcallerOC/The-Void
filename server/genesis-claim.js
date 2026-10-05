import process from "node:process";
import { Contract, JsonRpcProvider, Wallet, getAddress, id, isAddress, randomBytes } from "ethers";
import { ApiError } from "./api-errors.js";
import { productionChainId } from "./config.js";

export const GENESIS_CONTRACT = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
export const GENESIS_CHAIN_ID = 43114;
export const GENESIS_TOKEN_IDS = Object.freeze([0n, 1n, 2n, 3n]);
export const ELIGIBILITY_RULE_TEXT = "the-void:genesis-eligibility:v1:balanceOf(wallet,0)>0|balanceOf(wallet,1)>0|balanceOf(wallet,2)>0|balanceOf(wallet,3)>0";
export const ELIGIBILITY_RULE = id(ELIGIBILITY_RULE_TEXT);
export const LEGACY_FUJI_SINGLETON = "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6";

const GENESIS_ABI = ["function balanceOf(address account,uint256 id) view returns (uint256)"];
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
  "function claimsOpenedAt() view returns (uint256)",
  "function GENESIS_CONTRACT() view returns (address)",
  "function GENESIS_CHAIN_ID() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)",
];
const RELEASE_ABI = [
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
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

function httpUrl(value, name) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be an absolute HTTP(S) URL without credentials or a fragment.`);
  }
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
  const allocation = positiveBigInt(env.GENESIS_CLAIM_ALLOCATION, "GENESIS_CLAIM_ALLOCATION");
  const publicAllocation = positiveBigInt(env.GENESIS_PUBLIC_MINT_ALLOCATION, "GENESIS_PUBLIC_MINT_ALLOCATION");
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
    eligibilityRule: ELIGIBILITY_RULE,
    destinationChainId: config.destinationChainId,
    releaseContract: config.releaseContract,
    primarySale: config.primarySale,
    claimContract: config.claimContract,
    tokenId: config.tokenId.toString(),
    allocation: config.allocation.toString(),
    publicAllocation: config.publicAllocation.toString(),
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
  nonce = () => BigInt(randomBytes(32).toString("hex")),
} = {}) {
  if (!config) return null;
  const sourceProvider = genesisProvider || new JsonRpcProvider(config.genesisRpcUrl);
  const targetProvider = destinationProvider || new JsonRpcProvider(config.destinationRpcUrl);
  const claimSigner = signer || new Wallet(config.privateKey);
  const genesis = new Contract(GENESIS_CONTRACT, GENESIS_ABI, sourceProvider);
  const claim = new Contract(config.claimContract, CLAIM_ABI, targetProvider);
  const release = new Contract(config.releaseContract, RELEASE_ABI, targetProvider);
  const sale = new Contract(config.primarySale, SALE_ABI, targetProvider);

  async function verifyContractBindings() {
    const [network, claimRelease, claimSale, claimToken, claimAllocation, claimPublicAllocation, claimChain, claimOpenedAt,
      claimGenesis, claimGenesisChain, claimRule, claimSignerAddress, claimedSupply, maxSupply, editionData, saleData] = await Promise.all([
      targetProvider.getNetwork(), claim.releaseContract(), claim.primarySale(), claim.tokenId(), claim.allocation(),
      claim.publicAllocation(), claim.destinationChainId(), claim.claimsOpenedAt(), claim.GENESIS_CONTRACT(), claim.GENESIS_CHAIN_ID(),
      claim.ELIGIBILITY_RULE(), claim.signer(), claim.claimedSupply(), release.maxSupplyOf(config.tokenId),
      release.edition(config.tokenId), sale.sales(config.tokenId),
    ]);
    const total = config.allocation + config.publicAllocation;
    if (Number(network.chainId) !== config.destinationChainId
      || getAddress(claimRelease) !== config.releaseContract
      || getAddress(claimSale) !== config.primarySale
      || BigInt(claimToken) !== config.tokenId
      || BigInt(claimAllocation) !== config.allocation
      || BigInt(claimPublicAllocation) !== config.publicAllocation
      || BigInt(claimChain) !== BigInt(config.destinationChainId)
      || getAddress(claimGenesis) !== GENESIS_CONTRACT
      || BigInt(claimGenesisChain) !== BigInt(GENESIS_CHAIN_ID)
      || String(claimRule).toLowerCase() !== ELIGIBILITY_RULE.toLowerCase()
      || getAddress(claimSignerAddress) !== getAddress(claimSigner.address)
      || BigInt(maxSupply) < total
      || BigInt(editionData.mintedSupply ?? editionData[0]?.mintedSupply ?? editionData[0]?.[4] ?? editionData[4]) !== BigInt(saleData.sold ?? saleData[2]) + BigInt(claimedSupply)
      || BigInt(saleData.maxSupply ?? saleData[1]) !== config.publicAllocation
      || BigInt(saleData.startTime ?? saleData[4]) < BigInt(claimOpenedAt) + 86_400n
      || BigInt(clock()) >= BigInt(saleData.startTime ?? saleData[4])
      || !(saleData.configured ?? saleData[7])) {
      throw new ApiError(503, "CLAIM_BINDING_MISMATCH", "The configured claim contract, release, supply, or chain does not match the authorized target.");
    }
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
        const network = await sourceProvider.getNetwork();
        if (Number(network.chainId) !== GENESIS_CHAIN_ID) throw new Error("Genesis RPC is not Avalanche C-Chain (43114).");
        const balances = await Promise.all(GENESIS_TOKEN_IDS.map((tokenId) => genesis.balanceOf(getAddress(wallet), tokenId)));
        eligibleTokenIds = balances.flatMap((balance, index) => BigInt(balance) > 0n ? [GENESIS_TOKEN_IDS[index].toString()] : []);
      }
      return Object.freeze({ eligible: eligibleTokenIds.length > 0, eligibleTokenIds });
    } catch {
      throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Genesis ownership could not be verified on Avalanche C-Chain.");
    }
  }

  async function issueVoucher(wallet) {
    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) throw new ApiError(403, "ACCESS_DENIED", "This wallet does not own Genesis token 0, 1, 2, or 3.");
    try {
      if (bindingReader) await bindingReader();
      else await verifyContractBindings();
      const { alreadyClaimed, claimedSupply } = claimStateReader
        ? await claimStateReader(getAddress(wallet))
        : await Promise.all([claim.hasClaimed(getAddress(wallet)), claim.claimedSupply()]).then(([alreadyClaimed, claimedSupply]) => ({ alreadyClaimed, claimedSupply }));
      if (alreadyClaimed) throw new ApiError(409, "ALREADY_CLAIMED", "This wallet has already claimed its Genesis allocation.");
      if (BigInt(claimedSupply) >= config.allocation) throw new ApiError(409, "CLAIM_ALLOCATION_EXHAUSTED", "The reserved Genesis claim allocation has been exhausted.");
      const voucher = Object.freeze({
        claimant: getAddress(wallet),
        genesisContract: GENESIS_CONTRACT,
        genesisChainId: GENESIS_CHAIN_ID,
        eligibilityRule: ELIGIBILITY_RULE,
        destinationChainId: config.destinationChainId,
        releaseContract: config.releaseContract,
        tokenId: config.tokenId.toString(),
        quantity: "1",
        allocation: config.allocation.toString(),
        nonce: nonce().toString(),
        deadline: String(clock() + 300),
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
