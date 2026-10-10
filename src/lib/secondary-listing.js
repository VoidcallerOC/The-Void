import { Interface, getAddress, isAddress } from "ethers";
import { FUJI_RELEASE_PER_CONTRACT_V2, releaseDeploymentForMarketplace } from "../../config/release-network.js";
import { isCertifiedFujiEdition } from "./fuji-release.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MARKETPLACE_VIEW = new Interface([
  "function registry() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
  "function deploymentChainId() view returns (uint256)",
]);
const FACTORY_VIEW = new Interface(["function isRelease(address releaseContract) view returns (bool)"]);
const RELEASE_VIEW = new Interface([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function royaltyBpsOf(uint256 tokenId) view returns (uint96)",
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function validContractAddress(value) {
  return typeof value === "string" && isAddress(value) && getAddress(value) !== ZERO_ADDRESS;
}

async function read(provider, address, contractInterface, method, args = []) {
  const data = contractInterface.encodeFunctionData(method, args);
  const result = await provider.request({
    method: "eth_call",
    params: [{ to: address, data }, "latest"],
  });
  return contractInterface.decodeFunctionResult(method, result);
}

export function isReleasePerContractCandidate(edition) {
  const tokenId = edition?.tokenIds?.[0];
  return Number(edition?.chainId) === Number(FUJI_RELEASE_PER_CONTRACT_V2.chainId)
    && !isCertifiedFujiEdition(edition)
    && validContractAddress(edition?.contractAddress)
    && validContractAddress(edition?.primarySaleAddress)
    && tokenId !== undefined
    && tokenId !== null
    && /^\d+$/.test(String(tokenId));
}

export async function readReleaseListingContext({
  provider,
  marketplaceAddress,
  marketplaceChainId,
  releaseContractAddress,
  tokenId,
  seller,
}) {
  const expectedChainId = Number(FUJI_RELEASE_PER_CONTRACT_V2.chainId);
  // Each recorded deployment pairs one factory with the one marketplace whose registry it is.
  const deployment = validContractAddress(marketplaceAddress) ? releaseDeploymentForMarketplace(marketplaceAddress) : null;
  const expectedFeeBps = BigInt(FUJI_RELEASE_PER_CONTRACT_V2.marketplaceFeeBps);

  if (!provider?.request) fail("Connect a browser wallet to verify this release on chain.", "WALLET_REQUIRED");
  if (!deployment) {
    fail("The configured marketplace does not match the canonical Fuji release marketplace.", "MARKETPLACE_UNAVAILABLE");
  }
  const factoryAddress = getAddress(deployment.factoryAddress);
  const canonicalMarketplace = getAddress(deployment.marketplaceAddress);
  if (Number(marketplaceChainId) !== expectedChainId) {
    fail("The configured marketplace is not on the supported Fuji release network.", "MARKETPLACE_UNAVAILABLE");
  }
  if (!validContractAddress(releaseContractAddress) || !validContractAddress(seller)) {
    fail("The release contract or connected wallet address is invalid.", "UNSUPPORTED_RELEASE");
  }
  if (!/^\d+$/.test(String(tokenId))) fail("The release token ID is invalid.", "UNSUPPORTED_RELEASE");

  let connectedChainId;
  try {
    connectedChainId = Number(BigInt(await provider.request({ method: "eth_chainId" })));
  } catch {
    fail("The wallet network could not be verified. No listing action was taken.", "OWNERSHIP_READ_FAILED");
  }
  if (connectedChainId !== expectedChainId) {
    fail(`Switch to Avalanche Fuji (${expectedChainId}) to list this release.`, "WRONG_NETWORK");
  }

  let registry;
  let deployedChainId;
  let feeBps;
  try {
    [registry, feeBps, deployedChainId] = await Promise.all([
      read(provider, marketplaceAddress, MARKETPLACE_VIEW, "registry").then(([value]) => value),
      read(provider, marketplaceAddress, MARKETPLACE_VIEW, "platformFeeBps").then(([value]) => BigInt(value)),
      read(provider, marketplaceAddress, MARKETPLACE_VIEW, "deploymentChainId").then(([value]) => BigInt(value)),
    ]);
  } catch {
    fail("The configured marketplace could not be verified on chain. Listing is unavailable.", "MARKETPLACE_UNAVAILABLE");
  }
  if (getAddress(registry) !== factoryAddress || deployedChainId !== BigInt(expectedChainId) || feeBps !== expectedFeeBps) {
    fail("The marketplace deployment does not match the verified Fuji release factory, chain, or 250 bps fee.", "MARKETPLACE_UNAVAILABLE");
  }

  let isRelease;
  try {
    [isRelease] = await read(provider, factoryAddress, FACTORY_VIEW, "isRelease", [getAddress(releaseContractAddress)]);
  } catch {
    fail("The release factory could not verify this contract. No listing action was taken.", "OWNERSHIP_READ_FAILED");
  }
  if (!isRelease) fail("This contract is not registered as a release-per-contract asset by The-Void factory.", "UNSUPPORTED_RELEASE");

  let balance;
  let approved;
  let royaltyBps;
  try {
    [balance, approved, royaltyBps] = await Promise.all([
      read(provider, releaseContractAddress, RELEASE_VIEW, "balanceOf", [getAddress(seller), String(tokenId)]).then(([value]) => BigInt(value)),
      read(provider, releaseContractAddress, RELEASE_VIEW, "isApprovedForAll", [getAddress(seller), marketplaceAddress]).then(([value]) => Boolean(value)),
      read(provider, releaseContractAddress, RELEASE_VIEW, "royaltyBpsOf", [String(tokenId)]).then(([value]) => BigInt(value)),
    ]);
  } catch {
    fail("On-chain ownership or royalty details could not be read. Eligibility was not assumed.", "OWNERSHIP_READ_FAILED");
  }
  if (royaltyBps > 10_000n || feeBps + royaltyBps > 10_000n) {
    fail("The configured marketplace fee and edition royalty leave no valid seller proceeds.", "INVALID_ECONOMICS");
  }

  return Object.freeze({
    balance: balance.toString(),
    approved,
    marketplaceFeeBps: feeBps.toString(),
    royaltyBps: royaltyBps.toString(),
    factoryAddress,
    marketplaceAddress: canonicalMarketplace,
    releaseContractAddress: getAddress(releaseContractAddress),
    tokenId: String(tokenId),
    seller: getAddress(seller),
    chainId: expectedChainId,
  });
}

export function calculateListingEconomics({ priceWei, amount, marketplaceFeeBps, royaltyBps }) {
  if (![priceWei, amount, marketplaceFeeBps, royaltyBps].every((value) => /^\d+$/.test(String(value)))) return null;
  const quantity = BigInt(amount);
  const feeRate = BigInt(marketplaceFeeBps);
  const royaltyRate = BigInt(royaltyBps);
  const unitPrice = BigInt(priceWei);
  if (quantity <= 0n || unitPrice <= 0n || feeRate + royaltyRate > 10_000n) return null;

  const grossWei = unitPrice * quantity;
  const marketplaceFeeWei = grossWei * feeRate / 10_000n;
  const royaltyWei = grossWei * royaltyRate / 10_000n;
  return Object.freeze({
    grossWei: grossWei.toString(),
    marketplaceFeeWei: marketplaceFeeWei.toString(),
    royaltyWei: royaltyWei.toString(),
    sellerProceedsWei: (grossWei - marketplaceFeeWei - royaltyWei).toString(),
    sellerProceedsBps: (10_000n - feeRate - royaltyRate).toString(),
  });
}
