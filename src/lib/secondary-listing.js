import { Interface, getAddress, isAddress } from "ethers";
import { RELEASE_PER_CONTRACT, releaseDeploymentForMarketplace } from "../../config/release-network.js";
import { isCertifiedFujiEdition } from "./fuji-release.js";
import { LEGACY_COLLECTION_MARKETPLACE, isLegacyMarketplace, legacyCollectionFor } from "../../config/legacy-collection-marketplace.js";
import { UNIFIED_MARKETPLACE, isUnifiedMarketplace, isGenesisAsset, unifiedMarketplaceActive } from "../../config/unified-marketplace.js";

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

const LEGACY_MARKETPLACE_VIEW = new Interface([
  "function platformFeeBps() view returns (uint256)",
  "function deploymentChainId() view returns (uint256)",
  "function paused() view returns (bool)",
  "function isSupported(address tokenContract, uint256 tokenId) view returns (bool)",
  "function previewSettlement(address tokenContract, uint256 tokenId, uint256 salePrice) view returns (uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds)",
]);
const LEGACY_TOKEN_VIEW = new Interface([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function operatorFilterRegistry() view returns (address)",
]);
const OPERATOR_FILTER_VIEW = new Interface(["function isOperatorAllowed(address registrant, address operator) view returns (bool)"]);

/** True for an allowlisted legacy collection (Genesis) once its marketplace is deployed and recorded. */
export function isLegacyCollectionCandidate(edition, config = LEGACY_COLLECTION_MARKETPLACE) {
  return Boolean(legacyCollectionFor({ chainId: edition?.chainId, contractAddress: edition?.contractAddress, tokenId: edition?.tokenIds?.[0] }, config));
}

/**
 * The Genesis catalog entry covers several token ids (0-3) of one contract. Returns those ids (strings) when the
 * unified marketplace is active and every id is in the recorded Genesis range; null for any other edition, which keeps
 * listing its single tokenIds[0]. This only says which ids may be offered; ownership is read per exact id.
 */
export function genesisTokenChoices(edition, config = UNIFIED_MARKETPLACE) {
  const ids = Array.isArray(edition?.tokenIds) ? edition.tokenIds.map((id) => String(id)) : [];
  if (ids.length < 2 || !unifiedMarketplaceActive(config) || Number(edition?.chainId) !== Number(config.chainId)) return null;
  return ids.every((id) => isGenesisAsset(edition?.contractAddress, id, config)) ? Object.freeze([...new Set(ids)]) : null;
}

/** The ids among `tokenIds` that `owner` holds right now, read with balanceOf on each exact id. Throws on any failed read. */
export async function readOwnedTokenIds({ provider, tokenContractAddress, owner, tokenIds }) {
  if (!provider?.request) fail("Connect a browser wallet to read token ownership.", "WALLET_REQUIRED");
  if (!validContractAddress(tokenContractAddress) || !validContractAddress(owner)) fail("The token contract or wallet address is invalid.", "UNSUPPORTED_RELEASE");
  try {
    const balances = await Promise.all(tokenIds.map((id) => read(provider, getAddress(tokenContractAddress), LEGACY_TOKEN_VIEW, "balanceOf", [getAddress(owner), String(id)]).then(([value]) => BigInt(value))));
    return tokenIds.filter((_, index) => balances[index] > 0n);
  } catch {
    fail("On-chain ownership could not be read. Eligibility was not assumed.", "OWNERSHIP_READ_FAILED");
  }
}

export function isReleasePerContractCandidate(edition) {
  if (isLegacyCollectionCandidate(edition)) return true;
  if (unifiedMarketplaceActive() && Number(edition?.chainId) === Number(UNIFIED_MARKETPLACE.chainId) && isGenesisAsset(edition?.contractAddress, edition?.tokenIds?.[0])) return true;
  const tokenId = edition?.tokenIds?.[0];
  return Number(edition?.chainId) === Number(RELEASE_PER_CONTRACT.chainId)
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
  if (isUnifiedMarketplace(marketplaceAddress)) {
    return readUnifiedListingContext({ provider, marketplaceAddress, marketplaceChainId, tokenContractAddress: releaseContractAddress, tokenId, seller });
  }
  if (isLegacyMarketplace(marketplaceAddress)) {
    return readLegacyListingContext({ provider, marketplaceAddress, marketplaceChainId, tokenContractAddress: releaseContractAddress, tokenId, seller });
  }
  const expectedChainId = Number(RELEASE_PER_CONTRACT.chainId);
  // Each recorded deployment pairs one factory with the one marketplace whose registry it is.
  const deployment = validContractAddress(marketplaceAddress) ? releaseDeploymentForMarketplace(marketplaceAddress) : null;
  const expectedFeeBps = BigInt(RELEASE_PER_CONTRACT.marketplaceFeeBps);

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
    fail(`Switch to ${expectedChainId === 43114 ? "Avalanche C-Chain" : expectedChainId === 43113 ? "Avalanche Fuji" : `chain ${expectedChainId}`} (${expectedChainId}) to list this release. Ethereum is not supported.`, "WRONG_NETWORK");
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

/**
 * Pre-listing checks for an allowlisted legacy collection. The marketplace itself decides whether the asset is
 * supported and how a sale settles; this reads those answers (plus balance, approval and the collection's
 * operator filter) and refuses with an actionable code instead of letting a doomed transaction be signed.
 */
export async function readLegacyListingContext({ provider, marketplaceAddress, marketplaceChainId, tokenContractAddress, tokenId, seller }, config = LEGACY_COLLECTION_MARKETPLACE) {
  const expectedChainId = Number(config.chainId);
  if (!provider?.request) fail("Connect a browser wallet to verify this collection on chain.", "WALLET_REQUIRED");
  if (!isLegacyMarketplace(marketplaceAddress, config) || Number(marketplaceChainId) !== expectedChainId) {
    fail("The configured marketplace is not the recorded legacy-collection marketplace.", "MARKETPLACE_UNAVAILABLE");
  }
  const collection = legacyCollectionFor({ chainId: expectedChainId, contractAddress: tokenContractAddress, tokenId }, config);
  if (!collection) fail("This collection or token is not on the legacy-collection marketplace allowlist.", "UNSUPPORTED_RELEASE");
  if (!validContractAddress(seller)) fail("The connected wallet address is invalid.", "UNSUPPORTED_RELEASE");
  let connectedChainId;
  try { connectedChainId = Number(BigInt(await provider.request({ method: "eth_chainId" }))); } catch { fail("The wallet network could not be verified. No listing action was taken.", "OWNERSHIP_READ_FAILED"); }
  if (connectedChainId !== expectedChainId) fail(`Switch to Avalanche C-Chain (${expectedChainId}) to list this collection.`, "WRONG_NETWORK");

  const token = getAddress(tokenContractAddress);
  const market = getAddress(marketplaceAddress);
  let feeBps; let deployedChainId; let paused; let supported; let preview;
  try {
    [feeBps, deployedChainId, paused, supported, preview] = await Promise.all([
      read(provider, market, LEGACY_MARKETPLACE_VIEW, "platformFeeBps").then(([v]) => BigInt(v)),
      read(provider, market, LEGACY_MARKETPLACE_VIEW, "deploymentChainId").then(([v]) => BigInt(v)),
      read(provider, market, LEGACY_MARKETPLACE_VIEW, "paused").then(([v]) => Boolean(v)),
      read(provider, market, LEGACY_MARKETPLACE_VIEW, "isSupported", [token, String(tokenId)]).then(([v]) => Boolean(v)),
      read(provider, market, LEGACY_MARKETPLACE_VIEW, "previewSettlement", [token, String(tokenId), "1000000000000000000"]),
    ]);
  } catch {
    fail("This collection's royalty could not be settled by the marketplace right now (royalty above its cap, unreadable, or unpayable). Listing is unavailable.", "MARKETPLACE_UNAVAILABLE");
  }
  if (deployedChainId !== BigInt(expectedChainId) || feeBps !== BigInt(config.platformFeeBps)) {
    fail("The marketplace deployment does not match the recorded chain or 250 bps fee.", "MARKETPLACE_UNAVAILABLE");
  }
  if (paused) fail("The marketplace is paused. Listing is unavailable.", "MARKETPLACE_UNAVAILABLE");
  if (!supported) fail("The marketplace does not currently accept this collection or token.", "UNSUPPORTED_RELEASE");
  const royaltyReceiver = preview[1];
  if (collection.expectedRoyaltyReceiver && getAddress(royaltyReceiver) !== getAddress(collection.expectedRoyaltyReceiver)) {
    fail("The collection's royalty recipient changed from the recorded creator wallet. Listing is paused until it is reviewed.", "UNSUPPORTED_RELEASE");
  }
  const royaltyBps = (BigInt(preview[2]) * 10_000n) / 1_000_000_000_000_000_000n;

  try {
    // The collection's own operator filter can block this marketplace; surface it before approval is requested.
    const [filter] = await read(provider, token, LEGACY_TOKEN_VIEW, "operatorFilterRegistry");
    if (validContractAddress(filter)) {
      const [allowed] = await read(provider, filter, OPERATOR_FILTER_VIEW, "isOperatorAllowed", [token, market]);
      if (!allowed) fail("This collection's operator filter blocks the marketplace, so listings cannot settle.", "MARKETPLACE_UNAVAILABLE");
    }
  } catch (error) {
    if (error?.code) throw error;
    // No filter registry on the collection: nothing to check.
  }

  let balance;
  let approved;
  try {
    [balance, approved] = await Promise.all([
      read(provider, token, LEGACY_TOKEN_VIEW, "balanceOf", [getAddress(seller), String(tokenId)]).then(([v]) => BigInt(v)),
      read(provider, token, LEGACY_TOKEN_VIEW, "isApprovedForAll", [getAddress(seller), market]).then(([v]) => Boolean(v)),
    ]);
  } catch {
    fail("On-chain ownership could not be read. Eligibility was not assumed.", "OWNERSHIP_READ_FAILED");
  }
  return Object.freeze({
    balance: balance.toString(),
    approved,
    marketplaceFeeBps: feeBps.toString(),
    royaltyBps: royaltyBps.toString(),
    factoryAddress: null,
    marketplaceAddress: market,
    releaseContractAddress: token,
    tokenId: String(tokenId),
    seller: getAddress(seller),
    chainId: expectedChainId,
  });
}

const UNIFIED_MARKETPLACE_VIEW = new Interface([
  "function deploymentChainId() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function releaseFactory() view returns (address)",
  "function genesisCollection() view returns (address)",
  "function previewSettlement(address tokenContract, uint256 tokenId, uint256 salePrice) view returns (uint8 assetClass, uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds)",
]);
const UNIFIED_ASSET_CLASS = Object.freeze({ 1: "FACTORY_RELEASE", 2: "GENESIS" });

/**
 * Pre-listing checks for VoidUnifiedMarketplace. The contract classifies the asset and computes the settlement; this reads
 * that answer for a 1 AVAX probe, checks it against the recorded policy (0/5/95 Genesis, 2.5/2.5/95 factory), the operator
 * filter, balance and approval, and refuses with an actionable code instead of letting a doomed transaction be signed.
 */
export async function readUnifiedListingContext({ provider, marketplaceAddress, marketplaceChainId, tokenContractAddress, tokenId, seller }, config = UNIFIED_MARKETPLACE) {
  const expectedChainId = Number(config.chainId);
  if (!provider?.request) fail("Connect a browser wallet to verify this asset on chain.", "WALLET_REQUIRED");
  if (!isUnifiedMarketplace(marketplaceAddress, config) || Number(marketplaceChainId) !== expectedChainId) fail("The configured marketplace is not the recorded unified marketplace.", "MARKETPLACE_UNAVAILABLE");
  if (!validContractAddress(tokenContractAddress) || !validContractAddress(seller) || !/^\d+$/.test(String(tokenId))) fail("The asset or connected wallet address is invalid.", "UNSUPPORTED_RELEASE");
  let connectedChainId;
  try { connectedChainId = Number(BigInt(await provider.request({ method: "eth_chainId" }))); } catch { fail("The wallet network could not be verified. No listing action was taken.", "OWNERSHIP_READ_FAILED"); }
  if (connectedChainId !== expectedChainId) fail(`Switch to Avalanche C-Chain (${expectedChainId}) to list this asset.`, "WRONG_NETWORK");

  const token = getAddress(tokenContractAddress);
  const market = getAddress(marketplaceAddress);
  const probe = 1_000_000_000_000_000_000n;
  let deployedChainId; let feeRecipient; let releaseFactory; let genesisCollection;
  try {
    [deployedChainId, feeRecipient, releaseFactory, genesisCollection] = await Promise.all([
      read(provider, market, UNIFIED_MARKETPLACE_VIEW, "deploymentChainId").then(([v]) => BigInt(v)),
      read(provider, market, UNIFIED_MARKETPLACE_VIEW, "feeRecipient").then(([v]) => getAddress(v)),
      read(provider, market, UNIFIED_MARKETPLACE_VIEW, "releaseFactory").then(([v]) => getAddress(v)),
      read(provider, market, UNIFIED_MARKETPLACE_VIEW, "genesisCollection").then(([v]) => getAddress(v)),
    ]);
  } catch {
    fail("The unified marketplace could not be verified on chain. Listing is unavailable.", "MARKETPLACE_UNAVAILABLE");
  }
  if (deployedChainId !== BigInt(expectedChainId) || feeRecipient !== getAddress(config.feeRecipient) || releaseFactory !== getAddress(config.releaseFactoryAddress) || genesisCollection !== getAddress(config.genesis.address)) {
    fail("The marketplace deployment does not match the recorded chain, fee recipient, factory or Genesis collection.", "MARKETPLACE_UNAVAILABLE");
  }
  let preview;
  try { preview = await read(provider, market, UNIFIED_MARKETPLACE_VIEW, "previewSettlement", [token, String(tokenId), probe.toString()]); } catch {
    fail("The marketplace does not accept this asset, or its royalty does not match the marketplace policy. Listing is unavailable.", "UNSUPPORTED_RELEASE");
  }
  const assetClass = UNIFIED_ASSET_CLASS[Number(preview[0])];
  const feeBps = (BigInt(preview[1]) * 10_000n) / probe;
  const royaltyBps = (BigInt(preview[3]) * 10_000n) / probe;
  const expected = assetClass === "GENESIS" ? [BigInt(config.genesis.platformFeeBps), BigInt(config.genesis.royaltyBps)] : [BigInt(config.factoryPlatformFeeBps), BigInt(config.factoryRoyaltyBps)];
  if (!assetClass || feeBps !== expected[0] || royaltyBps !== expected[1]) fail("The marketplace settlement for this asset does not match the recorded policy.", "INVALID_ECONOMICS");
  if (assetClass === "GENESIS" && getAddress(preview[2]) !== getAddress(config.genesis.royaltyReceiver)) fail("The Genesis royalty recipient changed from the recorded creator wallet.", "UNSUPPORTED_RELEASE");

  if (assetClass === "GENESIS") {
    try {
      const [filter] = await read(provider, token, LEGACY_TOKEN_VIEW, "operatorFilterRegistry");
      if (validContractAddress(filter)) {
        const [allowed] = await read(provider, filter, OPERATOR_FILTER_VIEW, "isOperatorAllowed", [token, market]);
        if (!allowed) fail("This collection's operator filter blocks the marketplace, so listings cannot settle.", "MARKETPLACE_UNAVAILABLE");
      }
    } catch (error) {
      if (error?.code) throw error;
    }
  }
  let balance; let approved;
  try {
    [balance, approved] = await Promise.all([
      read(provider, token, LEGACY_TOKEN_VIEW, "balanceOf", [getAddress(seller), String(tokenId)]).then(([v]) => BigInt(v)),
      read(provider, token, LEGACY_TOKEN_VIEW, "isApprovedForAll", [getAddress(seller), market]).then(([v]) => Boolean(v)),
    ]);
  } catch {
    fail("On-chain ownership could not be read. Eligibility was not assumed.", "OWNERSHIP_READ_FAILED");
  }
  return Object.freeze({
    balance: balance.toString(),
    approved,
    assetClass,
    marketplaceFeeBps: feeBps.toString(),
    royaltyBps: royaltyBps.toString(),
    royaltyReceiver: getAddress(preview[2]),
    factoryAddress: assetClass === "GENESIS" ? null : releaseFactory,
    marketplaceAddress: market,
    releaseContractAddress: token,
    tokenId: String(tokenId),
    seller: getAddress(seller),
    chainId: expectedChainId,
  });
}

/**
 * Floor on the seller's net proceeds, in wei per unit, for LegacyCollectionMarketplace.createListingWithMinProceeds.
 * It is the floor of the exact-rate share, price * (10000 - fee - royalty) / 10000. Because the contract floors the fee and the
 * royalty, the seller's actual proceeds for any quantity are never below this, so a sale at today's royalty always clears it
 * and any royalty increase (however small) makes the purchase revert instead of paying the seller less.
 * `toleranceBps` lets a seller accept a bounded increase; it lowers the floor by that share of the unit price.
 * Returns null when no valid (non-zero) floor exists.
 */
export function minimumSellerProceedsPerUnit({ priceWei, marketplaceFeeBps, royaltyBps, toleranceBps = 0 }) {
  if (![priceWei, marketplaceFeeBps, royaltyBps, toleranceBps].every((value) => /^\d+$/.test(String(value)))) return null;
  const price = BigInt(priceWei);
  const keepBps = 10_000n - BigInt(marketplaceFeeBps) - BigInt(royaltyBps) - BigInt(toleranceBps);
  if (price <= 0n || keepBps < 0n) return null;
  const floor = (price * keepBps) / 10_000n;
  // The marketplace requires a non-zero floor. At prices so small that the exact-rate share rounds to 0 wei (about 1 wei) no
  // protective floor exists, so the listing must not be offered rather than sent to fail on chain.
  return floor > 0n ? floor.toString() : null;
}

/**
 * The seller-facing terms of the proceeds floor, for display and for what is sent: per edition and for the whole listing.
 * Null when no valid floor exists (see `minimumSellerProceedsPerUnit`).
 */
export function sellerFloorTerms({ priceWei, amount, marketplaceFeeBps, royaltyBps, toleranceBps = 0 }) {
  const perUnitWei = minimumSellerProceedsPerUnit({ priceWei, marketplaceFeeBps, royaltyBps, toleranceBps });
  if (perUnitWei === null || !/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n) return null;
  return Object.freeze({ perUnitWei, totalWei: (BigInt(perUnitWei) * BigInt(amount)).toString(), royaltyBps: String(royaltyBps), toleranceBps: Number(toleranceBps) });
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
